import {CARD_SOURCES,runEnrichment,storageCheck} from "./enrichment.js";
import {refreshHistory} from "./history.js";
import {probeTargetedActivity} from "./kaiten-targeted-activity.js";

const LOCK=332384504;
export const groups={
 detail:["detail","members","tags"],
 comments:["comments"],
 relations:["children","links","checklists"],
 blockers:["blockers"]
};
export const steps=["dictionaries","pilot","repeat","verify","activity",...Object.keys(groups),"authors","final"];
const writes=new Set(["dictionaries","pilot","repeat",...Object.keys(groups),"authors"]);
const freshState=()=>({stages:{},ids:[],baseline:null,verification:null});
const errorStatus=(status,message)=>Object.assign(new Error(message),{status});

export function makeEnrichmentAdmin({pool,config,fetcher=fetch,wait,blocked=()=>false}){
 let active=null;
 const space=config.spaceId;
 async function load(){
  const {rows:[row]}=await pool.query(`SELECT state FROM kaiten_enrichment_workflow WHERE space_id=$1`,[space]);
  return row?.state??freshState();
 }
 async function save(state){
  await pool.query(`INSERT INTO kaiten_enrichment_workflow(space_id,state) VALUES($1,$2)
   ON CONFLICT(space_id) DO UPDATE SET state=excluded.state`,[space,JSON.stringify(state)]);
 }
 async function status(){
  try {
   const state=await load();
   const {rows:[disk]}=await pool.query(`SELECT pg_database_size(current_database())::float8 AS database,
    (pg_total_relation_size('kaiten_dictionary_versions')+pg_total_relation_size('kaiten_enrichment_sources')+pg_total_relation_size('kaiten_enrichment_workflow'))::float8 AS extra`);
   const {rows:property}=await pool.query(`SELECT entity_id,source,
    COALESCE(value->>'name',value->>'title',CASE WHEN jsonb_typeof(value->'value') IN ('string','number','boolean')
     THEN value->>'value' END) AS label,value->>'type' AS type,count(*) OVER()::int AS total
    FROM kaiten_dictionary_versions WHERE space_id=$1 AND replaced_at IS NULL
    AND ((source='properties' AND entity_id='428033')
     OR source IN ('property:428033','select-values:428033','catalog-values:428033'))
    ORDER BY source,entity_id LIMIT 100`,[space]);
   return {...state,disk,property,available:true,running:active?.kind??null};
  } catch(error) {
   if (error.code==="42P01") return {...freshState(),available:false};
   throw error;
  }
 }
 async function pilotIds(){
  const {rows}=await pool.query(`WITH c AS(
   SELECT id, row_number() OVER(ORDER BY id) AS ord, archived,
    CASE WHEN jsonb_typeof(data->'properties')='object' AND data->'properties'<>'{}' THEN 1 ELSE 0 END AS props,
    CASE WHEN (data->>'blocked')='true' THEN 1 ELSE 0 END AS blocked,
    COALESCE(children_count,0) AS children,
    CASE WHEN (data->>'comments_total') ~ '^[0-9]{1,8}$' THEN (data->>'comments_total')::int ELSE 0 END AS comments
   FROM kaiten_cards WHERE space_id=$1
  ), picks AS (
   (SELECT id,1 AS priority FROM c WHERE archived ORDER BY ord LIMIT 1)
   UNION ALL (SELECT id,2 FROM c WHERE props=1 ORDER BY ord LIMIT 1)
   UNION ALL (SELECT id,3 FROM c WHERE children>0 ORDER BY children DESC,ord LIMIT 1)
   UNION ALL (SELECT id,4 FROM c WHERE comments>0 ORDER BY comments DESC,ord LIMIT 1)
   UNION ALL (SELECT id,5 FROM c WHERE blocked=1 ORDER BY ord LIMIT 1)
   UNION ALL (SELECT id,6 FROM c ORDER BY ord LIMIT 8)
  )
  SELECT id::text FROM picks GROUP BY id ORDER BY min(priority),id LIMIT 8`,[space]);
  return rows.map(row=>row.id);
 }
 async function coverage(ids=[]){
  const {rows}=await pool.query(`WITH wanted AS(
   SELECT id::text FROM kaiten_cards WHERE space_id=$1 AND (cardinality($2::bigint[])=0 OR id=ANY($2::bigint[]))
  )
  SELECT s.source,count(*)::int AS total,
   count(e.last_success_at)::int AS done,
   count(*) FILTER(WHERE e.result IN ('error','forbidden','not_found'))::int AS errors,
   count(e.subject)::int AS recorded,
   max(e.last_success_at) AS last
  FROM wanted w CROSS JOIN unnest($3::text[]) s(source)
  LEFT JOIN kaiten_enrichment_sources e ON e.space_id=$1 AND e.subject=w.id AND e.source=s.source
  GROUP BY s.source ORDER BY s.source`,[space,ids,CARD_SOURCES]);
  return rows;
 }
 async function start(kind,action,free){
  if (!steps.includes(kind)||!["start","resume","retry","stop"].includes(action)) throw errorStatus(400,"Неизвестная операция.");
  if (action==="stop") {
   if (active?.kind!==kind) throw errorStatus(409,"Этот этап сейчас не выполняется.");
   active.controller.abort();
   return;
  }
  if (active||blocked()) throw errorStatus(409,"Другая операция Kaiten уже выполняется.");
  const controller=new AbortController();
  active={kind,controller};
  let lock;
  let acquired=false;
  try {
   lock=await pool.connect();
   acquired=(await lock.query("SELECT pg_try_advisory_lock($1) AS ok",[LOCK])).rows[0].ok;
   if (!acquired) throw errorStatus(409,"Другая операция Kaiten уже выполняется.");
   const state=await load();
   const index=steps.indexOf(kind);
   if (steps.slice(0,index).some(step=>state.stages[step]?.state!=="done"))
    throw errorStatus(409,"Завершите и проверьте предыдущие этапы.");
   const stage=state.stages[kind];
   if (action==="resume"&&!["running","stopped","failed"].includes(stage?.state))
    throw errorStatus(409,"Нет прерванной операции.");
   if (action==="retry"&&!stage) throw errorStatus(409,"Этот этап ещё не выполнялся.");
   if (writes.has(kind)) {
    if (!Number.isInteger(free)||free<128||free>1000000) throw errorStatus(409,"Укажите свободное место тома PostgreSQL по Railway Metrics, минимум 128 МиБ.");
    await storageCheck(pool);
   }
   if (kind==="pilot"&&!state.ids.length) state.ids=await pilotIds();
   if (kind==="pilot"&&state.ids.length<5) throw errorStatus(409,"Для пробы нужно не менее пяти карточек.");
   const after=new Date();
   const checkpoint=(action==="resume"&&stage?.checkpoint)||after.toISOString();
   const {rows:[objects]}=await pool.query("SELECT count(*)::int AS total FROM kaiten_cards WHERE space_id=$1",[space]);
   const expected=["pilot","repeat"].includes(kind)?state.ids.length*CARD_SOURCES.length:
    groups[kind]?objects.total*groups[kind].length:kind==="authors"?objects.total:null;
   state.stages[kind]={state:"running",checkpoint,startedAt:after.toISOString(),expected,
    processed:action==="resume"?stage.processed:0,errors:action==="resume"?stage.errors:0,
    lastSuccess:stage?.lastSuccess??null,mode:action==="resume"?stage.mode:action};
   // Changing a finished early stage requires reviewing the dependent gates again.
   if (action!=="resume" && ["dictionaries","pilot","repeat","verify","activity"].includes(kind))
    for (const later of steps.slice(index+1)) delete state.stages[later];
   if (kind==="repeat" && action!=="resume") state.baseline=await coverage(state.ids);
   await save(state);
   active.task=run(state,kind,controller.signal).finally(async()=>{
    try {await lock.query("SELECT pg_advisory_unlock($1)",[LOCK]);lock.release();}
    catch {lock.release(true);}
    active=null;
   });
  } catch(error) {
   if (lock) {
    if (acquired) await lock.query("SELECT pg_advisory_unlock($1)",[LOCK]).catch(()=>{});
    lock.release(true);
   }
   active=null;
   if (error.code==="42P01") throw errorStatus(409,"Миграция 002 ещё не применена.");
   throw error;
  }
 }
 async function run(state,kind,signal){
  const stage=state.stages[kind];
  let permissionStreak=0;
  async function onProgress(result,http,source){
   if (source&&groups[kind]&&!groups[kind].includes(source)) return;
   stage.processed++;
   if (result==="ok"||result==="empty") stage.lastSuccess=new Date().toISOString();
   else stage.errors++;
   permissionStreak=[401,403].includes(http)?permissionStreak+1:0;
   if (stage.processed%8===0||permissionStreak>=3) await save(state);
   if (permissionStreak>=3) throw Object.assign(new Error("Kaiten permission check"),{permissionStop:true});
  }
  try {
   signal.throwIfAborted();
   if (kind==="verify"||kind==="final") {
    const rows=await coverage(kind==="verify"?state.ids:[]);
    if (kind==="verify" && (rows.length!==CARD_SOURCES.length||rows.some(row=>row.recorded!==state.ids.length)||
      !state.baseline||!rows.some(row=>row.source==="detail"&&row.done>=Math.min(5,state.ids.length))||rows.some(row=>row.recorded!==state.baseline.find(old=>old.source===row.source)?.recorded)))
     throw Object.assign(new Error("Pilot verification failed"),{pilotFailed:true});
    const {rows:[history]}=await pool.query(`SELECT count(*)::int AS checked,
     (SELECT count(*)::int FROM kaiten_location_events WHERE space_id=$1 AND author_id IS NOT NULL) AS authors,
     (SELECT count(*)::int FROM kaiten_location_events WHERE space_id=$1) AS events
     FROM kaiten_history_loads WHERE space_id=$1 AND authors_checked_at IS NOT NULL`,[space]);
    state.verification={kind,rows,history};
    await onProgress("ok",200);
   } else if (kind==="activity") {
    state.activity=await probeTargetedActivity({pool,config,fetcher,wait,signal:AbortSignal.any([signal,AbortSignal.timeout(90000)])});
    stage.processed=state.activity.probes.filter(row=>row.pages||row.status).length;
    stage.errors=state.activity.probes.filter(row=>!row.pages).length;
    if (state.activity.probes.some(row=>row.pages)) stage.lastSuccess=new Date().toISOString();
    else throw Object.assign(new Error("No activity response"),{noActivity:true});
    if (state.activity.probes.some(row=>row.status===401||row.status===429))
     throw Object.assign(new Error("Activity interrupted"),{status:state.activity.probes.find(row=>row.status===401||row.status===429).status});
   } else {
    let hasMore=true;
    const runUntil=Date.now()+5*60*1000;
    while (hasMore&&!signal.aborted) {
     if (Date.now()>=runUntil) throw Object.assign(new Error("Batch time budget"),{budget:true});
     if (kind==="authors") {
      await storageCheck(pool);
      let seen=0, fatalStatus=null;
      const result=await refreshHistory({pool,config,mode:"authors",fetcher,wait:wait ? ms=>wait(ms) : undefined,limit:16,checkpoint:stage.checkpoint,
       errorsOnly:stage.mode==="retry",shouldStop:()=>signal.aborted||permissionStreak>=3||fatalStatus!==null,
       onProgress:row=>{
        if (row.processed===seen) return;
        seen=row.processed;
        if ([401,429].includes(row.status)) fatalStatus=row.status;
        permissionStreak=[401,403].includes(row.status)?permissionStreak+1:0;
        stage.processed++;
        if (["loaded","empty"].includes(row.result)) stage.lastSuccess=new Date().toISOString();
        else stage.errors++;
       }});
      if (result.skipped) throw Object.assign(new Error("Loader busy"),{busy:true});
      await save(state);
      if (fatalStatus) throw Object.assign(new Error("Kaiten temporarily unavailable"),{status:fatalStatus});
      if (permissionStreak>=3) throw Object.assign(new Error("Kaiten permission check"),{permissionStop:true});
      hasMore=result.selected===16;
     } else {
      const pilot=["pilot","repeat"].includes(kind);
      const result=await runEnrichment({pool,config,fetcher,wait,signal,onProgress,mode:kind==="dictionaries"?"dictionaries":
       stage.mode==="retry"?"errors":"pending",checkpoint:stage.checkpoint,limit:16,maxRequests:300,
       ids:pilot?state.ids:undefined,sources:groups[kind],onlyErrors:stage.mode==="retry",force:pilot&&stage.mode!=="retry"});
      if (result.skipped) throw Object.assign(new Error("Loader busy"),{busy:true});
      hasMore=result.cards===16;
     }
    }
   }
   stage.state=signal.aborted?"stopped":"done";
  } catch(error) {
   stage.state=signal.aborted?"stopped":"failed";
   stage.reason=error.pilotFailed?"Проба не подтверждена. Проверьте результаты и повторите этапы.":
    error.permissionStop||error.status===401?"Систематический отказ в доступе Kaiten.":
    error.status===429?"Достигнут лимит Kaiten. Продолжите позже.":
    error.budget?"Сработал лимит запросов или объёма.":
    error.busy?"Другой загрузчик уже работает.":"Операция не завершилась.";
  }
  stage.finishedAt=new Date().toISOString();
  await save(state).catch(()=>{});
 }
 return {start,status,busy:()=>Boolean(active),settle:()=>active?.task,stop:()=>active?.controller.abort()};
}
