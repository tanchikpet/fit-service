import {apiId,makeEnrichmentApi} from "./enrichment-api.js";

const BOARD="898832";
const COLUMNS=["3189879","3189878","3189992","3189965","3189877"];
const actions=[
 ["Карточки и поля",["card_update","card:update"]],
 ["Ответственные и участники",["card_assign_responsible","card_relieve_responsible","card_member:add","card_member:update","card_member:remove"]],
 ["Оценки, сроки и свойства",["card_update_due_date","card_update_estimate","card_update_custom_property","card_update_type"]],
 ["Связи",["card_add_relation","card_remove_relation","card_add_child","card_remove_child"]],
 ["Доски и колонки",["board_update","board:update","column_update","column:update","column:add","column:remove"]],
 ["Архив и восстановление",["card_archive","card_unarchive","card_restore","card_remove"]]
];
const tracked=/^(?:due_date|planned_start|planned_end|owner_id|responsible_id|members|type_id|priority|asap|size|size_unit|estimate_workload|properties|id_\d+|parents_ids|children_ids|condition|archived|board_id|column_id|lane_id|blockers|title|type)$/;
const windows=[
 ["2025","2025-01-01T00:00:00Z","2025-12-31T23:59:59Z"],
 ["2026","2026-01-01T00:00:00Z","2026-11-28T23:59:59Z"]
];
const isObject=value=>value && typeof value==="object" && !Array.isArray(value);
const knownIds=values=>[...new Set(values.map(apiId).filter(Boolean))];

function eventEvidence(event){
 const payloads=[event,event.data,event.payload,event.changes].filter(isObject);
 const fields=new Set();
 for (const data of payloads) {
  for (const [oldKey,newKey] of [["old","new"],["before","after"],["old_value","new_value"]]) {
   if (!Object.hasOwn(data,oldKey)||!Object.hasOwn(data,newKey)) continue;
   const a=data[oldKey],b=data[newKey];
   const field=data.field ?? data.field_name ?? data.property;
   if (typeof field==="string"&&tracked.test(field)&&JSON.stringify(a)!==JSON.stringify(b)) fields.add(field);
   if (isObject(a)&&isObject(b)) {
    for (const key of Object.keys(a)) {
     if (tracked.test(key)&&Object.hasOwn(b,key)&&JSON.stringify(a[key])!==JSON.stringify(b[key])) fields.add(key);
    }
   }
  }
 }
 const cards=knownIds(payloads.flatMap(p=>[p.card_id,p.card?.id]));
 const columns=knownIds(payloads.flatMap(p=>[p.column_id,p.column?.id,p.old?.column_id,p.new?.column_id,
  /^(column[:_])/.test(String(event.action)) ? p.column?.id ?? p.entity_id ?? p.new?.id ?? p.old?.id : null]));
 const boards=knownIds(payloads.flatMap(p=>[p.board_id,p.board?.id,p.old?.board_id,p.new?.board_id]));
 const entities=knownIds(payloads.flatMap(p=>[p.entity_id,p.entity?.id]));
 const author=knownIds(payloads.flatMap(p=>[p.author_id,p.author?.id]))[0]??null;
 const dated=typeof event.created==="string"&&Number.isFinite(Date.parse(event.created))?
  new Date(event.created).toISOString():null;
 const action=typeof event.action==="string"&&/^[a-z][a-z0-9:_-]{0,80}$/i.test(event.action)?event.action:null;
 return {id:apiId(event.id),dated,action,cards,columns,boards,entities,author,fields:[...fields].sort()};
}

async function historicalRoutes(pool,space){
 const db=await pool.connect();
 try {
  await db.query("BEGIN READ ONLY");
  await db.query("SET LOCAL statement_timeout='8s'");
  const {rows}=await db.query(`WITH positions AS (
   SELECT *,lag(board_id) OVER history AS prior_board,lag(column_id) OVER history AS prior_column
   FROM kaiten_location_events WHERE space_id=$1
   WINDOW history AS(PARTITION BY card_id ORDER BY changed_at,event_id)
  ), ordered AS (
   SELECT card_id,event_id,board_id,column_id,changed_at,
    lag(board_id) OVER history AS previous_board,lag(column_id) OVER history AS previous_column,
    lead(board_id) OVER history AS next_board,lead(column_id) OVER history AS next_column
   FROM positions WHERE (board_id,column_id) IS DISTINCT FROM (prior_board,prior_column)
   WINDOW history AS(PARTITION BY card_id ORDER BY changed_at,event_id)
  ), filtered AS (
   SELECT *,row_number() OVER(PARTITION BY column_id,card_id ORDER BY changed_at,event_id) AS card_rank
   FROM ordered WHERE board_id=$2 AND column_id=ANY($3::bigint[])
  ), routes AS (
   SELECT column_id,previous_board,previous_column,next_board,next_column,count(*)::int AS cards,
    (array_agg(card_id::text ORDER BY changed_at,card_id))[1:3] AS examples
   FROM filtered WHERE card_rank=1 GROUP BY column_id,previous_board,previous_column,next_board,next_column
  ), ranked AS (
   SELECT *,row_number() OVER(PARTITION BY column_id ORDER BY cards DESC,previous_column,next_column) AS rank FROM routes
  )
  SELECT column_id::text,previous_board::text,previous_column::text,next_board::text,next_column::text,cards,examples
  FROM ranked WHERE rank<=3 ORDER BY column_id,rank`,[space,BOARD,COLUMNS]);
  await db.query("COMMIT");
  return rows;
 } catch(error) {
  await db.query("ROLLBACK").catch(()=>{});
  throw error;
 } finally {db.release();}
}

export async function probeTargetedActivity({pool,config,fetcher,wait,signal=AbortSignal.timeout(90000)}){
 const routes=await historicalRoutes(pool,config.spaceId);
 const api=makeEnrichmentApi({config,fetcher,wait,signal,maxRequests:32});
 const probes=[], evidence=new Map(), names=new Map();
 const sampleCards=new Set(routes.flatMap(row=>row.examples));
 const endpoint="/spaces/"+config.spaceId+"/activity";
 let stopped=null;
 for (const [year,from,to] of windows) {
  for (const [label,filter] of [["Контроль без actions",[]],...actions]) {
   const row={year,label,filter:filter.join(", "),status:null,pages:0,items:0,next:false,
    matched:0,other:0,entityMatches:0,causes:[],actions:[]};
   probes.push(row);
   if (stopped) {row.causes.push(stopped);continue;}
   let cursor;
   try {
    for (let page=0;page<2;page++) {
     const {data,status}=await api.get(endpoint,{created_after:from,created_before:to,limit:20,
      ...(filter.length?{actions:filter.join(",")}:{}),...(cursor?{cursor}:{})});
     row.status=status;
     if (!Array.isArray(data?.items)) throw new Error("Invalid activity response");
     row.pages++;
     row.items+=data.items.length;
     for (const record of data.items) {
      const event=eventEvidence(record);
      if (!event.dated || Date.parse(event.dated)<Date.parse(from) || Date.parse(event.dated)>Date.parse(to)) {
       if (!row.causes.includes("Есть события вне окна или без даты."))
        row.causes.push("Есть события вне окна или без даты.");
       continue;
      }
      if (event.action && !row.actions.includes(event.action)) row.actions.push(event.action);
      if (filter.includes(event.action)) row.matched++;
      else if (filter.length) row.other++;
      const relevantColumn=event.columns.some(id=>COLUMNS.includes(id));
      const relevantCard=event.cards.some(id=>sampleCards.has(id));
      if (relevantColumn||relevantCard) row.entityMatches++;
      if (event.fields.length||relevantColumn||relevantCard) {
       if (event.id) evidence.set(event.id,event);
      }
      if (!/^column[:_](update|rename)/.test(event.action??"")||!relevantColumn) continue;
      // A title is attributed only to a column explicitly identified by the changed object.
      for (const payload of [record,record.data,record.payload,record.changes].filter(isObject)) {
       for (const [a,b] of [[payload.old,payload.new],[payload.before,payload.after]]) {
        const column=apiId(b?.id??a?.id);
        if (!COLUMNS.includes(column)||apiId(b?.board_id??a?.board_id)!==BOARD||
         (a?.title===b?.title&&a?.type===b?.type)) continue;
        const key=column+":"+String(event.id??event.dated);
        names.set(key,{column,date:event.dated,oldName:typeof a?.title==="string"?a.title.slice(0,200):null,
         newName:typeof b?.title==="string"?b.title.slice(0,200):null,
         oldType:Number.isInteger(a?.type)?a.type:null,newType:Number.isInteger(b?.type)?b.type:null});
       }
      }
     }
     const next=typeof data.next_cursor==="string"&&data.next_cursor ? data.next_cursor:null;
     row.next=Boolean(next);
     if (!next) break;
     if (next===cursor) throw new Error("Activity cursor repeated");
     cursor=next;
    }
    if (row.next) row.causes.push("Остановлено после двух страниц; выборка неполная.");
    if (filter.length&&row.other) row.causes.push("Ответ включает действия вне переданного фильтра.");
    if (!row.items) row.causes.push("Пустая выборка не подтверждает отсутствие действия.");
   } catch(error) {
    if (error.status) row.status=error.status;
    if ([401,429].includes(error.status)) stopped="Остановлено после HTTP "+error.status;
    if (error.budget||signal.aborted) stopped="Исчерпан лимит запросов или времени.";
    row.causes.push(stopped??(error.status?"HTTP "+error.status:"Ошибка сети или формата ответа."));
   }
  }
 }
 return {probes,routes,evidence:[...evidence.values()].slice(0,60),names:[...names.values()],
  requests:api.count(),columns:COLUMNS};
}

export function makeTargetedActivity(options){
 let report=null, running=false, failed=false, started=0;
 return {
  start(){
   if (running||Date.now()-started<60000) return false;
   running=true;
   failed=false;
   started=Date.now();
   void probeTargetedActivity(options).then(value=>{report=value;},()=>{failed=true;})
    .finally(()=>{running=false;});
   return true;
  },
  status:()=>({running,failed,report})
 };
}
