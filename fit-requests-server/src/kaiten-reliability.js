import {CARD_SOURCES,runEnrichment} from "./enrichment.js";
import {refreshHistory,HISTORY_LOCK} from "./history.js";

const RUN_LOCK=332384507;
const HOUR=3600000;
const DAY=24*HOUR;
const urgentInterval=15*60000;
const phases={
 daily:["changed","history_changed","dictionaries","history","authors","checklists","reconcile"],
 urgent:["changed","history_changed"],
 manual:["changed","history_changed","dictionaries","reconcile"],
 checklists:["checklists"],
 authors:["authors"]
};
const historyPhase=phase=>["history","history_changed","authors"].includes(phase);

export function dailySlot(now=new Date()){
 const boundary=Math.floor((now.getTime()+HOUR)/DAY)*DAY-HOUR;
 return {slot:new Date(boundary+7*HOUR).toISOString().slice(0,10),next:new Date(boundary+DAY)};
}

async function captureSnapshots(db,space,ids){
 await db.query(`WITH current AS (
  SELECT c.id,jsonb_strip_nulls(jsonb_build_object(
   'owner',c.owner_id,'member_ids',c.member_ids,'due_date',COALESCE(c.data->'due_date',c.data->'due'),
   'estimate',c.estimate_raw,'estimate_unit',c.estimate_unit,'estimate_workload',c.data->'estimate_workload','type',c.data->'type_id',
   'priority',c.data->'priority','rr_priority',COALESCE(d.payload->'properties'->'id_428033',d.payload->'properties'->'428033',c.data->'properties'->'id_428033',c.data->'properties'->'428033'),
   'parents',COALESCE(d.payload->'parents_ids',c.data->'parents_ids'),
   'children',c.data->'children_ids','board',c.board_id,'column',c.column_id,'lane',c.lane_id
  )) || COALESCE(s.values,'{}') AS value
  FROM kaiten_cards c LEFT JOIN kaiten_enrichment_sources d ON d.space_id=c.space_id AND d.subject=c.id::text AND d.source='detail'
  LEFT JOIN LATERAL (
   SELECT jsonb_object_agg(source,CASE
    WHEN source='children' AND payload='[]' THEN COALESCE(c.data->'children_ids','[]')
    ELSE payload END) AS values
   FROM kaiten_enrichment_sources WHERE space_id=c.space_id AND subject=c.id::text
     AND source IN ('members','children','blockers','checklists') AND last_success_at IS NOT NULL
  ) s ON TRUE WHERE c.space_id=$1 AND c.id=ANY($2::bigint[])
 ), changes AS (
  INSERT INTO kaiten_observed_changes(space_id,card_id,old_values,new_values)
  SELECT $1,c.id,p.value,c.value FROM current c JOIN kaiten_observed_snapshots p ON p.space_id=$1 AND p.card_id=c.id
  WHERE c.value IS DISTINCT FROM p.value
 )
 INSERT INTO kaiten_observed_snapshots(space_id,card_id,value) SELECT $1,id,value FROM current
 ON CONFLICT(space_id,card_id) DO UPDATE SET value=excluded.value
 WHERE kaiten_observed_snapshots.value IS DISTINCT FROM excluded.value`,[space,ids]);
}

async function selectCards(db,space,phase,checkpoint,limit=6){
 if (historyPhase(phase)) {
  const {rows}=await db.query(`SELECT c.id FROM kaiten_cards c
   LEFT JOIN kaiten_history_loads h ON h.space_id=c.space_id AND h.card_id=c.id
   WHERE c.space_id=$1 AND (h.last_attempt_at IS NULL OR h.last_attempt_at<$2)
    AND (h.http_status IS NULL OR h.http_status NOT IN (403,404) OR h.last_attempt_at < now()-interval '30 days')
    AND (($3 AND EXISTS (SELECT FROM kaiten_location_events e WHERE e.space_id=c.space_id AND e.card_id=c.id
                          AND e.author_id IS NULL AND e.author_checked_at IS NULL))
     OR (NOT $3 AND (h.last_success_at IS NULL OR h.result='error' OR c.updated_at>h.last_success_at
                       OR ($4 AND h.last_success_at < now()-interval '30 days'))))
   ORDER BY h.last_attempt_at NULLS FIRST,c.id LIMIT $5`,[space,checkpoint,phase==="authors",phase==="history",limit]);
  return rows.map(row=>row.id);
 }
 const {rows}=await db.query(`SELECT c.id FROM kaiten_cards c
  CROSS JOIN unnest($4::text[]) AS k(source)
  LEFT JOIN kaiten_enrichment_sources e ON e.space_id=c.space_id AND e.subject=c.id::text AND e.source=k.source
  WHERE c.space_id=$1 AND (e.last_attempt_at IS NULL OR e.last_attempt_at<$2)
   AND (e.http_status IS NULL OR e.http_status NOT IN (403,404) OR e.last_attempt_at < now()-interval '30 days')
   AND CASE $3
   WHEN 'changed' THEN e.source IS NULL OR
    (e.source_version IS DISTINCT FROM COALESCE(extract(epoch FROM c.updated_at)::text,'') AND e.last_attempt_at<c.synced_at)
    OR (e.result='error' AND e.http_status IS DISTINCT FROM 200)
   WHEN 'checklists' THEN e.result='error' AND e.http_status IS NULL
   ELSE e.last_attempt_at < now()-interval '14 days'
   END
  GROUP BY c.id ORDER BY bool_or(e.source IS NULL OR e.last_attempt_at<c.synced_at) DESC,
   min(e.last_attempt_at) NULLS FIRST,c.id LIMIT $5`,
 [space,checkpoint,phase,phase==="checklists"?["checklists"]:CARD_SOURCES,limit]);
 return rows.map(row=>row.id);
}

export function makeKaitenReliability({pool,config,blocked=()=>false,
 enabled=process.env.KAITEN_SYNC_DAILY==="true",databaseLimit=Number(process.env.KAITEN_SYNC_DATABASE_LIMIT_BYTES),fetcher=fetch,wait,urgentCards=Number(process.env.KAITEN_SYNC_URGENT_CARDS)}){
 const space=config.spaceId;
 const urgentLimit=Number.isInteger(urgentCards)&&urgentCards>=6&&urgentCards<=12?urgentCards:6;
 let active;
 let timer;
 let stopping=false;
 async function available(db=pool){
  const {rows:[row]}=await db.query("SELECT to_regclass('kaiten_reliability_runs') IS NOT NULL AS ready");
  return row.ready;
 }
 async function status(){
  if (!await available()) return {available:false};
  const {rows:runs}=await pool.query(`SELECT *,slot::text AS slot,EXTRACT(EPOCH FROM
   COALESCE(finished_at,clock_timestamp())-started_at)::int AS seconds FROM kaiten_reliability_runs
   WHERE space_id=$1 ORDER BY started_at DESC`,[space]);
  const run=runs.find(row=>!row.finished_at)??runs[0];
  const [changed,history]=await Promise.all(["changed","history_changed"].map(phase=>
   selectCards(pool,space,phase,new Date(),null).then(ids=>ids.length)));
  return {available:true,enabled,next:enabled?dailySlot().next:null,run,runs,changed,history,urgentLimit,busy:!!active,
   resourceLimit:Number.isSafeInteger(databaseLimit)&&databaseLimit>0};
 }
 async function tick(requested=null){
  if (active || blocked() || stopping) return;
  active=execute(requested);
  try {return await active;} finally {active=null;}
 }
 async function execute(requested){
  const lock=await pool.connect();
  let acquired=false;
  let discard=false;
  try {
   if (!await available(lock)) return "migration_required";
   acquired=(await lock.query("SELECT pg_try_advisory_lock($1) AS acquired",[RUN_LOCK])).rows[0].acquired;
   if (!acquired) return "busy";
   if (!Number.isSafeInteger(databaseLimit) || databaseLimit<=0) return "resource_limit_required";
   const {slot}=dailySlot();
   const {rows:runs}=await lock.query("SELECT *,slot::text AS slot FROM kaiten_reliability_runs WHERE space_id=$1",[space]);
   let run=runs.find(row=>!row.finished_at);
   if (run && requested && run.kind!==requested) return "busy";
   if (run && !requested && ["401","403"].includes(run.outcome?.paused)) return "authorization";
   if (!run) {
    const previousDaily=runs.find(row=>row.kind==="daily");
    const previousUrgent=runs.find(row=>["urgent","daily"].includes(row.kind) && Date.now()-new Date(row.finished_at)<urgentInterval);
    const kind=requested ?? (!enabled?null:previousDaily?.slot!==slot?"daily":previousUrgent?null:"urgent");
    if (!kind) return;
    const {rows:[gate]}=await lock.query("SELECT pg_try_advisory_lock($1) AS free",[HISTORY_LOCK]);
    if (!gate.free) return "busy";
    await lock.query("SELECT pg_advisory_unlock($1)",[HISTORY_LOCK]);
    ({rows:[run]}=await lock.query(`INSERT INTO kaiten_reliability_runs
      (space_id,kind,slot,started_at,database_before) VALUES($1,$2,$3,clock_timestamp(),pg_database_size(current_database()))
     ON CONFLICT(space_id,kind) DO UPDATE SET slot=excluded.slot,started_at=excluded.started_at,
      phase=0,batches=0,finished_at=NULL,outcome='{}',requests=0,database_before=excluded.database_before,database_after=NULL
     RETURNING *`,[space,kind,slot]));
   }
   const {rows:[resources]}=await lock.query(`SELECT pg_database_size(current_database()) AS bytes,
    pg_total_relation_size('kaiten_observed_changes') + pg_total_relation_size('kaiten_observed_snapshots') AS observed_bytes,
    (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND pid<>pg_backend_pid()) AS active`);
   if (Number(resources.bytes)>=databaseLimit || Number(resources.active)>=5 || Number(resources.observed_bytes)>=64*1024*1024) {
    await lock.query("UPDATE kaiten_reliability_runs SET outcome=outcome||jsonb_build_object('paused','resource_limit') WHERE space_id=$1 AND kind=$2",[space,run.kind]);
    return "resource_limit";
   }
   if (Number(run.outcome?.retryAfter)>Date.now()) return "deferred";
   const runPhases=phases[run.kind];
   const phase=runPhases[run.phase];
   let requests=0;
   const countedFetch=(...args)=>{requests++;return fetcher(...args);};
   try {
    let outcome={};
    let selected=0;
    if (phase==="dictionaries") {
     outcome=await runEnrichment({pool,config,mode:phase,fetcher:countedFetch,wait,checkpoint:run.started_at,maxRequests:90,stopOnForbidden:true});
    } else {
     const ids=await selectCards(lock,space,phase,run.started_at,historyPhase(phase)?12:run.kind==="urgent"?urgentLimit:6);
     selected=ids.length;
     if (ids.length && historyPhase(phase)) {
      let fatal;
      let retryAfter;
      let denied=0;
      outcome=await refreshHistory({pool,config,ids,fetcher:countedFetch,wait,stopOnRateLimit:true,
       shouldStop:()=>stopping||!!fatal,onProgress:state=>{
        if ([401,429].includes(state.status) || state.status===403&&++denied>=5) {fatal=state.status;retryAfter=state.retryAfter;}
       }});
      if (fatal) throw Object.assign(new Error("History API paused"),{status:fatal,retryAfter});
     } else if (ids.length) {
      outcome=await runEnrichment({pool,config,ids,fetcher:countedFetch,wait,mode:"pending",force:phase!=="changed",
       sources:phase==="checklists"?["checklists"]:CARD_SOURCES,checkpoint:run.started_at,maxRequests:90,stopOnForbidden:true,scheduledPhase:phase});
      if (!outcome.skipped) await captureSnapshots(lock,space,ids);
     }
    }
    if (outcome.skipped) return "busy";
    if (selected) outcome.selected=selected;
    const previous=run.outcome?.[phase]??{};
    for (const key of Object.keys(outcome)) outcome[key]+=previous[key]??0;
    outcome={...previous,...outcome};
    const advance=phase==="dictionaries"||selected===0||run.batches>=(run.kind==="urgent"?0:3);
    await lock.query(`UPDATE kaiten_reliability_runs SET phase=phase+$5::int,
     batches=CASE WHEN $5::int=1 THEN 0 ELSE batches+1 END,
     requests=requests+$6, database_after=pg_database_size(current_database()),
     outcome=(outcome-'paused'-'retryAfter')||jsonb_build_object($2::text,COALESCE(outcome->$2::text,'{}')||$3::jsonb),
     finished_at=CASE WHEN phase=$4 AND $5::int=1 THEN clock_timestamp() END,
     last_success_at=CASE WHEN phase=$4 AND $5::int=1 AND NOT EXISTS(
      SELECT FROM jsonb_each(outcome||jsonb_build_object($2::text,$3::jsonb)) e
      WHERE COALESCE((e.value->>'error')::int,0)+COALESCE((e.value->>'forbidden')::int,0)+COALESCE((e.value->>'not_found')::int,0)>0) THEN clock_timestamp() ELSE last_success_at END
     WHERE space_id=$1 AND kind=$7`,[space,phase,JSON.stringify(outcome),runPhases.length-1,advance?1:0,requests,run.kind]);
    return advance&&run.phase===runPhases.length-1?"finished":"progress";
   } catch(error){
    const reason=[401,403,429].includes(error.status)?String(error.status):error.budget?"budget":"error";
    await lock.query("UPDATE kaiten_reliability_runs SET outcome=outcome||jsonb_build_object('paused',$2::text,'retryAfter',$3::bigint), requests=requests+$5,database_after=pg_database_size(current_database()) WHERE space_id=$1 AND kind=$4",[space,reason,Date.now()+Math.max(60000,error.retryAfter??0),run.kind,requests]);
    return reason;
   }
  } finally {
   if (acquired) {
    try {await lock.query("SELECT pg_advisory_unlock($1)",[RUN_LOCK]);}
    catch {discard=true;}
   }
   lock.release(discard);
  }
 }
 async function start(kind="manual"){
  if (!["manual","checklists","authors"].includes(kind)) throw new Error("Invalid run kind");
  const result=await tick(kind);
  if (!result) return "busy";
  return result;
 }
 return {status,busy:()=>!!active,tick,start,
  schedule(){timer=setInterval(()=>resume().catch(()=>{}),60000);resume().catch(()=>{});},
  async stop(){stopping=true;clearInterval(timer);await active;}
 };
 async function resume(){await tick();}
}
