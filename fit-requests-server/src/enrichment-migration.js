import {createHash,randomBytes} from "node:crypto";
import {setupEnrichment} from "./db.js";
import {HISTORY_LOCK} from "./history.js";

const TTL=5*60*1000;
const reject=(message,status=409)=>Object.assign(new Error(message),{status});
const fingerprint=cookie=>createHash("sha256").update(String(cookie??"")).digest("hex");

async function schema(db){
 const {rows:[row]}=await db.query(`WITH objects AS (
  SELECT to_regclass('kaiten_location_events') AS events,to_regclass('kaiten_history_loads') AS loads
 ), added AS (
  SELECT count(*)::int AS columns,
   count(*) FILTER(WHERE NOT attnotnull AND NOT atthasdef AND
    ((attname='author_id' AND atttypid='bigint'::regtype) OR
     (attname='authors_checked_at' AND atttypid='timestamptz'::regtype)))::int AS compatible
  FROM pg_attribute,objects WHERE NOT attisdropped AND
   ((attrelid=events AND attname='author_id') OR (attrelid=loads AND attname='authors_checked_at'))
 )
 SELECT events IS NOT NULL AND loads IS NOT NULL AS "baseReady",
  COALESCE((SELECT bool_and(pg_has_role(relowner,'USAGE')) FROM pg_class WHERE oid IN (events,loads)),false)
   AND has_schema_privilege(current_schema(),'CREATE') AS permission,
  NOT current_setting('transaction_read_only')::boolean AND NOT pg_is_in_recovery() AS writable,
  added.columns + (to_regclass('kaiten_dictionary_versions') IS NOT NULL)::int +
   (to_regclass('kaiten_enrichment_sources') IS NOT NULL)::int +
   (to_regclass('kaiten_enrichment_workflow') IS NOT NULL)::int +
   (to_regclass('kaiten_dictionary_current') IS NOT NULL)::int AS existing,
  added.compatible=2 AND
   to_regclass('kaiten_dictionary_versions') IS NOT NULL AND
   to_regclass('kaiten_enrichment_sources') IS NOT NULL AND
   to_regclass('kaiten_enrichment_workflow') IS NOT NULL AND EXISTS(
    SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('kaiten_dictionary_current')
     AND indrelid=to_regclass('kaiten_dictionary_versions') AND indisvalid AND indisunique
   ) AS applied
 FROM objects,added`);
 return row;
}
function requireReady(state){
 if (!state.baseReady) throw reject("Таблицы существующей истории не найдены. Миграция не выполнялась.");
 if (state.existing&&!state.applied) throw reject("Найдена частично изменённая схема. Нужна отдельная проверка.");
 if (!state.applied&&(!state.permission||!state.writable)) throw reject("Подключение PostgreSQL не может применить миграцию.");
}
export function makeEnrichmentMigration({pool,space,blocked}){
 const confirmations=new Map();
 let active=false;
 async function prepare(cookie){
  if (active||blocked()) throw reject("Сначала дождитесь завершения текущей операции Kaiten.");
  const state=await schema(pool);
  requireReady(state);
  const {rows:[counts]}=await pool.query(`SELECT
   (SELECT count(*)::int FROM kaiten_location_events WHERE space_id=$1) AS events,
   (SELECT count(*)::int FROM kaiten_history_loads WHERE space_id=$1 AND last_success_at IS NOT NULL) AS histories`,[space]);
  if (state.applied) return {applied:true,counts};
  const {rows:[availability]}=await pool.query("SELECT pg_try_advisory_xact_lock($1) AS ready",[HISTORY_LOCK]);
  if (!availability.ready) throw reject("Загрузчик истории ещё работает. Повторите проверку позже.");
  const now=Date.now();
  for (const [key,value] of confirmations) if (value.until<=now) confirmations.delete(key);
  const token=randomBytes(24).toString("base64url");
  confirmations.set(fingerprint(cookie),{token,until:now+TTL});
  return {applied:false,counts,token};
 }
 async function apply(cookie,token,confirmed){
  const session=fingerprint(cookie);
  const grant=confirmations.get(session);
  if (!confirmed||!grant||grant.until<=Date.now()||grant.token!==token)
   throw reject("Сначала пройдите проверку готовности и подтвердите миграцию.",403);
  if (active||blocked()) throw reject("Сначала дождитесь завершения текущей операции Kaiten.");
  confirmations.delete(session);
  active=true;
  let counts;
  const count=async db=>(await db.query(`SELECT
   (SELECT count(*)::int FROM kaiten_location_events WHERE space_id=$1) AS events,
   (SELECT count(*)::int FROM kaiten_history_loads WHERE space_id=$1 AND last_success_at IS NOT NULL) AS histories`,[space])).rows[0];
  try {
   await setupEnrichment(pool,{
    before:async db=>{
     const {rows:[lock]}=await db.query("SELECT pg_try_advisory_xact_lock($1) AS ready",[HISTORY_LOCK]);
     if (!lock.ready) throw reject("Загрузчик истории уже работает. Повторите проверку позже.");
     requireReady(await schema(db));
     counts=await count(db);
    },
    after:async db=>{
     const state=await schema(db);
     const after=await count(db);
     if (!state.applied||after.events!==counts.events||after.histories!==counts.histories)
      throw reject("Контроль схемы или счётчиков не пройден. Миграция отменена.");
    }
   });
   return {applied:true,counts};
  } catch(error) {
   if(error.status)throw error;
   throw reject(error.code==="55P03"||error.code==="57014"?
    "PostgreSQL не освободил таблицы вовремя. Миграция отменена.": "PostgreSQL не подтвердил применение миграции. Обновите проверку готовности.");
  } finally {active=false;}
 }
 return {prepare,apply,busy:()=>active};
}

export function migrationResult({applied,counts,token},escape){
 return `<main><h1>Миграция 002</h1>
 <section class="card"><p>${applied?"Миграция 002 применена. Загрузка данных не запускалась.":"Проверка готовности пройдена. Миграция добавляет поля и таблицы загрузки."}</p>
 <p>Событий истории ${escape(counts.events)}. Успешно загруженных историй ${escape(counts.histories)}.</p>
 ${token?`<form action="/app/analytics/enrichment-migration" method="post">
 <input type="hidden" name="token" value="${escape(token)}">
 <p><label><input type="checkbox" name="confirmed" value="yes" required> Подтверждаю применение добавочной миграции 002.</label></p>
 <button class="button" name="action" value="apply">Применить миграцию 002</button>
 </form><p>Подтверждение действует пять минут.</p>`:""}
 <p><a href="/app/analytics#kaiten-enrichment">Вернуться к аналитике</a></p></section></main>`;
}
