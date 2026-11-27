import {statfs} from "node:fs/promises";
import {HISTORY_LOCK, refreshHistory} from "./history.js";
import {listKaitenLocations} from "./kaiten.js";

const MIN_FREE_BYTES = 64 * 1024 * 1024;
const PREFLIGHT_MS = 30 * 60 * 1000;

export function historyAccess(user, method, validOrigin) {
 if (!user) return 401;
 if (user.role !== "admin") return 403;
 if (method === "GET") return 200;
 if (method !== "POST") return 405;
 return validOrigin ? 200 : 403;
}

export async function historySnapshot(pool,spaceId) {
 const {rows:[row]} = await pool.query(`SELECT
  count(*)::int AS cards,
  count(h.last_success_at)::int AS loaded,
  count(*) FILTER (WHERE h.last_attempt_at IS NULL)::int AS pending,
  count(*) FILTER (WHERE h.result IN ('error','forbidden','not_found'))::int AS errors,
  max(h.last_success_at) AS "lastSuccess",
  (SELECT count(*)::int FROM kaiten_location_events WHERE space_id=$1) AS events
  FROM kaiten_cards c LEFT JOIN kaiten_history_loads h ON h.space_id=c.space_id AND h.card_id=c.id
  WHERE c.space_id=$1`,[spaceId]);
 return row;
}

async function readiness({pool,config,fetcher}) {
 const {rows:[schema]} = await pool.query(`SELECT
  to_regclass('kaiten_cards') IS NOT NULL AS cards,
  to_regclass('kaiten_location_events') IS NOT NULL AS events,
  to_regclass('kaiten_history_loads') IS NOT NULL AS loads,
  EXISTS (
   SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('kaiten_location_events_by_board')
    AND indrelid=to_regclass('kaiten_location_events') AND indisvalid AND indisready
  ) AS "boardIndex",
  (SELECT count(*)=2 FROM pg_index
   WHERE indrelid IN (to_regclass('kaiten_location_events'),to_regclass('kaiten_history_loads'))
     AND indisprimary AND indisvalid AND indisready) AS "primaryKeys",
  pg_try_advisory_xact_lock($1) AS unlocked,
  pg_database_size(current_database())::text AS "databaseBytes"`,[HISTORY_LOCK]);
 if (!schema.cards || !schema.events || !schema.loads || !schema.boardIndex || !schema.primaryKeys) {
  throw failure(409,"Таблицы или индексы истории недоступны.");
 }
 if (!schema.unlocked) throw failure(409,"Другая загрузка уже выполняется.");
 const counts = await historySnapshot(pool,config.spaceId);
 if (counts.cards < 5) throw failure(409,"Для пробной партии нужно не менее пяти карточек.");
 const {rows} = await pool.query(`SELECT id FROM kaiten_cards
  WHERE space_id=$1 ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT 6`,[config.spaceId]);
 // Check the same endpoint as the loader. A denied card does not prove that
 // the token or endpoint is unusable for other cards.
 let apiOk = false;
 for (const {id} of rows.slice(0,3)) {
  try {
   await listKaitenLocations({base:config.kaitenBase,token:config.kaitenToken,cardId:id,
    fetcher:(url,options) => fetcher(url,{...options,signal:AbortSignal.timeout(5000)}),
    wait:async () => {throw new Error("API test failed");}});
   apiOk = true;
   break;
  } catch (error) {
   if (![403,404].includes(error.status)) break;
  }
 }
 if (!apiOk) throw failure(409,"Не удалось подтвердить доступ к истории через API Kaiten.");
 const storage = await statfs(process.cwd());
 const freeBytes = storage.bavail * storage.bsize;
 const memoryLimit = process.constrainedMemory?.();
 if (freeBytes < MIN_FREE_BYTES || (memoryLimit && memoryLimit - process.memoryUsage.rss < MIN_FREE_BYTES)) {
  throw failure(409,"Недостаточно свободного диска или памяти в контейнере приложения.");
 }
 return {counts,ids:rows.map(row=>row.id),freeBytes,databaseBytes:Number(schema.databaseBytes)};
}

const failure = (status,message) => Object.assign(new Error(message),{status});

export function makeHistoryAdmin({pool,config,fetcher=fetch,check=readiness,refresh=refreshHistory}) {
 let ready = null;
 let trial = null;
 let job = null;
 let task;
 const current = () => job?.finishedAt == null && job != null;
 const fresh = () => ready && Date.now()-ready.at < PREFLIGHT_MS;
 async function status() {
  let counts;
  try {counts = await historySnapshot(pool,config.spaceId);} catch {counts = null;}
  return {counts,ready:ready && {at:ready.at,counts:ready.counts,freeBytes:ready.freeBytes,databaseBytes:ready.databaseBytes},
   trial,fresh:Boolean(fresh()),job:job && {...job}};
 }
 function stop() {
  if (current() && job.kind !== "check") job.stop = true;
 }
 function start(kind,{volumeChecked=false}={}) {
  if (kind === "stop") {stop();return;}
  if (!["check","trial","pending"].includes(kind)) throw failure(400,"Неизвестное действие.");
  if (current()) throw failure(409,"Другая операция уже выполняется.");
  if (kind !== "check" && !fresh()) throw failure(409,"Сначала проверьте готовность.");
  if (kind === "pending" && (!trial?.passed || !volumeChecked)) {
   throw failure(409,"Нужна успешная пробная партия и подтверждение свободного места на томе PostgreSQL.");
  }
  if (kind === "trial") trial = null;
  if (kind === "check") ready = null;
  job = {kind,startedAt:Date.now(),finishedAt:null,state:"running",stop:false,progress:null};
  task = run();
 }
 async function run() {
  try {
   if (job.kind === "check") {
    ready = {...await check({pool,config,fetcher}),at:Date.now()};
    job.state = "done";
    return;
   }
   const pilot = job.kind === "trial";
   const ids = pilot ? ready.ids : [];
   let blocked = false;
   const pass = () => refresh({pool,config,ids,fetcher,
    shouldStop:()=>job.stop || blocked,
    onProgress:update=>{
     const {status,result,...progress}=update;
     job.progress=progress;
     if (result === "error") {
      blocked = true;
      job.errorStatus = status ?? null;
     }
    }});
   job.phase = 1;
   const first = await pass();
   if (first.skipped) throw failure(409,"Другая загрузка уже выполняется.");
   if (pilot && !job.stop && !blocked && first.loaded + first.empty >= 5) {
    const firstProgress = job.progress;
    job.phase = 2;
    const repeat = await pass();
    if (repeat.skipped) throw failure(409,"Другая загрузка уже выполняется.");
    const secondProgress = job.progress;
    trial = {first:firstProgress,repeat:secondProgress,duration:Date.now()-job.startedAt,
     passed:!job.stop && !blocked && repeat.loaded + repeat.empty >= 5 &&
       firstProgress.processed === ids.length && secondProgress.processed === ids.length &&
       secondProgress.inserted === 0};
   }
   if (pilot && !trial) trial = {first:job.progress,repeat:null,duration:Date.now()-job.startedAt,passed:false};
   job.state = job.stop ? "stopped" : blocked || (pilot && !trial.passed) ? "failed" : "done";
   if (blocked) job.message = "Загрузка остановлена после ошибки API. Сохранённые события доступны.";
   else if (pilot && !trial.passed && !job.stop) job.message = "Пробная партия не прошла. Проверьте результаты обоих запусков.";
  } catch (error) {
   job.state = "failed";
   job.message = error.status === 409
    ? error.message : "Операция не завершена. Проверьте доступность PostgreSQL и повторите проверку готовности.";
  } finally {
   job.finishedAt = Date.now();
  }
 }
 return {status,start,stop,settle:()=>task};
}
