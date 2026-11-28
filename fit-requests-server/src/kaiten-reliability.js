import {CARD_SOURCES,runEnrichment} from "./enrichment.js";
import {refreshHistory,HISTORY_LOCK} from "./history.js";

const RUN_LOCK=332384507;
const HOUR=3600000;
const DAY=24*HOUR;
const phases=["dictionaries","history","authors","changed","checklists","reconcile"];

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

async function selectCards(db,space,phase,checkpoint){
 if (phase==="history" || phase==="authors") {
  const {rows}=await db.query(`SELECT c.id FROM kaiten_cards c
   LEFT JOIN kaiten_history_loads h ON h.space_id=c.space_id AND h.card_id=c.id
   WHERE c.space_id=$1 AND (h.last_attempt_at IS NULL OR h.last_attempt_at<$2)
    AND (h.http_status IS NULL OR h.http_status NOT IN (403,404) OR h.last_attempt_at < now()-interval '30 days')
    AND (($3 AND EXISTS (SELECT FROM kaiten_location_events e WHERE e.space_id=c.space_id AND e.card_id=c.id
                          AND e.author_id IS NULL AND e.author_checked_at IS NULL))
     OR (NOT $3 AND (h.last_success_at IS NULL OR h.result='error' OR c.synced_at>h.last_attempt_at
                       OR h.last_success_at < now()-interval '30 days')))
   ORDER BY h.last_attempt_at NULLS FIRST,c.id LIMIT 12`,[space,checkpoint,phase==="authors"]);
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
  GROUP BY c.id ORDER BY min(e.last_attempt_at) NULLS FIRST,c.id LIMIT 6`,
 [space,checkpoint,phase,phase==="checklists"?["checklists"]:CARD_SOURCES]);
 return rows.map(row=>row.id);
}

export function makeKaitenReliability({pool,config,blocked=()=>false,
 enabled=process.env.KAITEN_SYNC_DAILY==="true",databaseLimit=Number(process.env.KAITEN_SYNC_DATABASE_LIMIT_BYTES),fetcher=fetch,wait}){
 const space=config.spaceId;
 let active;
 let timer;
 let stopping=false;
 async function available(db=pool){
  const {rows:[row]}=await db.query("SELECT to_regclass('kaiten_reliability_runs') IS NOT NULL AS ready");
  return row.ready;
 }
 async function status(){
  if (!await available()) return {available:false};
  const {rows:[run]}=await pool.query("SELECT *,slot::text AS slot FROM kaiten_reliability_runs WHERE space_id=$1",[space]);
  return {available:true,enabled,next:enabled?dailySlot().next:null,run,busy:!!active,
   resourceLimit:Number.isSafeInteger(databaseLimit)&&databaseLimit>0};
 }
 async function tick(manual=false){
  if (active || blocked() || stopping) return;
  active=execute(manual);
  try {return await active;} finally {active=null;}
 }
 async function execute(manual){
  const lock=await pool.connect();
  let acquired=false;
  let discard=false;
  try {
   if (!await available(lock)) return "migration_required";
   acquired=(await lock.query("SELECT pg_try_advisory_lock($1) AS acquired",[RUN_LOCK])).rows[0].acquired;
   if (!acquired) return "busy";
   if (!Number.isSafeInteger(databaseLimit) || databaseLimit<=0) return "resource_limit_required";
   const {slot}=dailySlot();
   const {rows:[existing]}=await lock.query("SELECT *,slot::text AS slot FROM kaiten_reliability_runs WHERE space_id=$1",[space]);
   if (!manual && existing?.finished_at && existing.slot===slot) return;
   if (!existing || existing.finished_at) {
    const {rows:[gate]}=await lock.query("SELECT pg_try_advisory_lock($1) AS free",[HISTORY_LOCK]);
    if (!gate.free) return "busy";
    await lock.query("SELECT pg_advisory_unlock($1)",[HISTORY_LOCK]);
    await lock.query(`INSERT INTO kaiten_reliability_runs(space_id,slot,started_at) VALUES($1,$2,clock_timestamp())
     ON CONFLICT(space_id) DO UPDATE SET slot=excluded.slot,started_at=excluded.started_at,phase=0,batches=0,finished_at=NULL,outcome='{}'`,[space,slot]);
   }
   const {rows:[run]}=await lock.query("SELECT *,slot::text AS slot FROM kaiten_reliability_runs WHERE space_id=$1",[space]);
   const {rows:[resources]}=await lock.query(`SELECT pg_database_size(current_database()) AS bytes,
    pg_total_relation_size('kaiten_observed_changes') + pg_total_relation_size('kaiten_observed_snapshots') AS observed_bytes,
    (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND pid<>pg_backend_pid()) AS active`);
   if (Number(resources.bytes)>=databaseLimit || Number(resources.active)>=5 || Number(resources.observed_bytes)>=64*1024*1024) {
    await lock.query("UPDATE kaiten_reliability_runs SET outcome=outcome||jsonb_build_object('paused','resource_limit') WHERE space_id=$1",[space]);
    return "resource_limit";
   }
   if (Number(run.outcome?.retryAfter)>Date.now()) return "deferred";
   const phase=phases[run.phase];
   try {
    let outcome={};
    let selected=0;
    if (phase==="dictionaries") {
     outcome=await runEnrichment({pool,config,mode:phase,fetcher,wait,checkpoint:run.started_at,maxRequests:90,stopOnForbidden:true});
    } else {
     const ids=await selectCards(lock,space,phase,run.started_at);
     selected=ids.length;
     if (ids.length && ["history","authors"].includes(phase)) {
      let fatal;
      let retryAfter;
      let denied=0;
      outcome=await refreshHistory({pool,config,ids,fetcher,wait,stopOnRateLimit:true,
       shouldStop:()=>stopping||!!fatal,onProgress:state=>{
        if ([401,429].includes(state.status) || state.status===403&&++denied>=5) {fatal=state.status;retryAfter=state.retryAfter;}
       }});
      if (fatal) throw Object.assign(new Error("History API paused"),{status:fatal,retryAfter});
     } else if (ids.length) {
      outcome=await runEnrichment({pool,config,ids,fetcher,wait,mode:"pending",force:phase!=="changed",
       sources:phase==="checklists"?["checklists"]:CARD_SOURCES,checkpoint:run.started_at,maxRequests:90,stopOnForbidden:true,scheduledPhase:phase});
      if (!outcome.skipped) await captureSnapshots(lock,space,ids);
     }
    }
    if (outcome.skipped) return "busy";
    const previous=run.outcome?.[phase]??{};
    for (const key of Object.keys(outcome)) outcome[key]+=previous[key]??0;
    outcome={...previous,...outcome};
    const advance=phase==="dictionaries"||selected===0||run.batches>=3;
    await lock.query(`UPDATE kaiten_reliability_runs SET phase=phase+$5::int,
     batches=CASE WHEN $5::int=1 THEN 0 ELSE batches+1 END,
     outcome=(outcome-'paused'-'retryAfter')||jsonb_build_object($2::text,COALESCE(outcome->$2::text,'{}')||$3::jsonb),
     finished_at=CASE WHEN phase=$4 AND $5::int=1 THEN clock_timestamp() END,
     last_success_at=CASE WHEN phase=$4 AND $5::int=1 AND NOT EXISTS(
      SELECT FROM jsonb_each(outcome||jsonb_build_object($2::text,$3::jsonb)) e
      WHERE COALESCE((e.value->>'error')::int,0)+COALESCE((e.value->>'forbidden')::int,0)+COALESCE((e.value->>'not_found')::int,0)>0) THEN clock_timestamp() ELSE last_success_at END
     WHERE space_id=$1`,[space,phase,JSON.stringify(outcome),phases.length-1,advance?1:0]);
    return advance&&run.phase===phases.length-1?"finished":"progress";
   } catch(error){
    const reason=[401,403,429].includes(error.status)?String(error.status):error.budget?"budget":"error";
    await lock.query("UPDATE kaiten_reliability_runs SET outcome=outcome||jsonb_build_object('paused',$2::text,'retryAfter',$3::bigint) WHERE space_id=$1",[space,reason,Date.now()+Math.max(60000,error.retryAfter??0)]);
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
 async function start(){
  const result=await tick(true);
  if (!result) return "busy";
  return result;
 }
 return {status,busy:()=>!!active,tick,start,
  schedule(){timer=setInterval(()=>resume().catch(()=>{}),60000);resume().catch(()=>{});},
  async stop(){stopping=true;clearInterval(timer);await active;}
 };
 async function resume(){
  if (!await available()) return;
  if (!enabled) {
   const {rows:[run]}=await pool.query("SELECT finished_at FROM kaiten_reliability_runs WHERE space_id=$1",[space]);
   if (!run || run.finished_at) return;
  }
  const {rows:[run]}=await pool.query("SELECT outcome FROM kaiten_reliability_runs WHERE space_id=$1",[space]);
  if (["401","403"].includes(run?.outcome?.paused)) return;
  await tick();
 }
}
