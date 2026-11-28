import {isDeepStrictEqual} from "node:util";
import {HISTORY_LOCK} from "./history.js";
import {apiId,requireId,makeEnrichmentApi} from "./enrichment-api.js";

export const CARD_SOURCES=["detail","members","tags","children","links","blockers","comments","checklists"];
const STORAGE_LIMIT=64*1024*1024;
const PAYLOAD_LIMIT=256*1024;
const allowed=(obj,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(obj,key)).map(key=>[key,obj[key]]));
const entity=(item,fields,parent={})=>({id:requireId(item.id ?? item.user_id),...allowed(item,fields),...parent});
const idList=value=>Array.isArray(value) ? [...new Set(value.map(x=>requireId(typeof x==="object" ? x.id : x)))].sort():null;
const common=["title","name","type","archived","condition"];
const isObject=value=>value && typeof value==="object" && !Array.isArray(value);
const displayName=x=>x.full_name ?? x.name ?? null;
const apiStatus=e=>e.status===403?"forbidden":e.status===404?"not_found":"error";

async function transaction(pool,fn){
 const db=await pool.connect();
 try {
  await db.query("BEGIN");
  const value=await fn(db);
  await db.query("COMMIT");
  return value;
 } catch(error) {
  await db.query("ROLLBACK").catch(()=>{});
  throw error;
 } finally {db.release();}
}

export async function storageCheck(db){
 const {rows:[row]}=await db.query(`SELECT
  pg_total_relation_size('kaiten_dictionary_versions')+pg_total_relation_size('kaiten_enrichment_sources')+
    pg_total_relation_size('kaiten_enrichment_workflow') AS bytes`);
 if (Number(row.bytes)>=STORAGE_LIMIT) throw Object.assign(new Error("Enrichment storage limit"),{budget:true});
}

async function writeState(db,{space,subject,source,payload,version=null,result,status,startedAt}){
 const success=result==="ok"||result==="empty";
 await db.query(`INSERT INTO kaiten_enrichment_sources
 (space_id,subject,source,payload,last_success_at,source_version,last_attempt_at,result,http_status)
 VALUES($1,$2,$3,$4,CASE WHEN $5 THEN clock_timestamp() END,$6,$7,$8,$9)
 ON CONFLICT(space_id,subject,source) DO UPDATE SET
 payload=CASE WHEN $5 THEN excluded.payload ELSE kaiten_enrichment_sources.payload END,
 last_success_at=COALESCE(excluded.last_success_at,kaiten_enrichment_sources.last_success_at),
 source_version=CASE WHEN $5 THEN excluded.source_version ELSE kaiten_enrichment_sources.source_version END,
 last_attempt_at=excluded.last_attempt_at,result=excluded.result,http_status=excluded.http_status`,
 [space,subject,source,payload===null?null:JSON.stringify(payload),success,version,startedAt,result,status]);
}

async function saveDictionary(pool,space,source,items,startedAt){
 const observed=new Set();
 for (const item of items) {
  if (observed.has(item.id)) throw new Error("Duplicate dictionary ID");
  observed.add(item.id);
 }
 const json=JSON.stringify(items);
 if (Buffer.byteLength(json)>1024*1024) throw new Error("Dictionary payload too large");
 await transaction(pool,async db=>{
  await storageCheck(db);
  // Only a fully fetched source can close an observation interval.
  await db.query(`UPDATE kaiten_dictionary_versions d SET replaced_at=$3
   WHERE space_id=$1 AND source=$2 AND replaced_at IS NULL AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements($4::jsonb) j WHERE j->>'id'=d.entity_id AND j=d.value)`,
   [space,source,startedAt,json]);
  await db.query(`UPDATE kaiten_dictionary_versions d SET last_observed_at=$3
   WHERE space_id=$1 AND source=$2 AND replaced_at IS NULL AND EXISTS(
    SELECT 1 FROM jsonb_array_elements($4::jsonb) j WHERE j->>'id'=d.entity_id AND j=d.value)`,
   [space,source,startedAt,json]);
  await db.query(`INSERT INTO kaiten_dictionary_versions(space_id,source,entity_id,value,first_observed_at,last_observed_at)
   SELECT $1,$2,j->>'id',j,$3,$3 FROM jsonb_array_elements($4::jsonb) j
   ON CONFLICT (space_id,source,entity_id) WHERE replaced_at IS NULL DO NOTHING`,[space,source,startedAt,json]);
  await writeState(db,{space,subject:"dictionary",source,payload:null,result:items.length?"ok":"empty",status:200,startedAt});
 });
}

export async function refreshDictionaries({pool,space,api,totals,checkpoint,signal,onProgress,onlyErrors}){
 const {rows:[observed]}=await pool.query(`SELECT ARRAY(
  SELECT DISTINCT regexp_replace(k,'^id_','') FROM kaiten_cards c,
  LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(data->'properties')='object' THEN data->'properties' ELSE '{}' END) k
  WHERE space_id=$1 AND k ~ '^(id_)?[1-9][0-9]{0,17}$'
 ) AS ids`,[space]);
 async function saved(source){
  if (!checkpoint) return null;
  const {rows}=await pool.query(`SELECT v.value FROM kaiten_enrichment_sources e
   LEFT JOIN kaiten_dictionary_versions v ON v.space_id=e.space_id AND v.source=e.source AND v.replaced_at IS NULL
   WHERE e.space_id=$1 AND e.subject='dictionary' AND e.source=$2 AND ($4::boolean OR e.last_success_at>=$3)
    AND e.result IN ('ok','empty') ORDER BY v.entity_id`,[space,source,checkpoint,Boolean(onlyErrors)]);
  return rows.length?rows.map(row=>row.value).filter(Boolean):null;
 }
 async function load(source,path,mode,project,query,optional=false){
  signal?.throwIfAborted();
  const prior=await saved(source);
  if (prior) return prior;
  const startedAt=new Date();
  let items;
  try { items=(await api.list(path,mode,query)).map(project); }
  catch(error){
   if (signal?.aborted||error.budget) throw error;
   const result=apiStatus(error);
   await writeState(pool,{space,subject:"dictionary",source,payload:null,startedAt,result,status:error.status??null});
   totals[result]++;
   await onProgress?.(result,error.status);
   if ([401,429].includes(error.status)) throw error;
   return optional?[]:null;
  }
  await saveDictionary(pool,space,source,items,startedAt);
  totals[items.length?"ok":"empty"]++;
  await onProgress?.(items.length?"ok":"empty",200);
  return items;
 }
 const boards=await load("boards","/spaces/"+space+"/boards","single",x=>entity(x,common));
 await load("users","/spaces/"+space+"/users","user",x=>({
  ...entity(x,["activated","role_id"]),name:displayName(x)
 }));
 await load("types","/card-types","offset",x=>entity(x,common));
 await load("tags","/tags","offset",x=>entity(x,common));
 const properties=await load("properties","/company/custom-properties","offset",x=>entity(x,common));
 const byId=new Map((properties??[]).map(x=>[x.id,x]));
 for (const property of new Set(["428033",...observed.ids])) {
  if (!byId.has(property)) {
   signal?.throwIfAborted();
   const source="property:"+property;
   const prior=await saved(source);
   if (prior?.length) {
    byId.set(property,prior[0]);
    continue;
   }
   const startedAt=new Date();
   let item;
   try {
    const {data}=await api.get("/company/custom-properties/"+requireId(property));
    item=entity(data,common);
    if (item.id!==property) throw new Error("Unexpected property");
   } catch(error) {
    if (signal?.aborted||error.budget) throw error;
    const result=apiStatus(error);
    await writeState(pool,{space,subject:"dictionary",source,payload:null,startedAt,result,status:error.status??null});
    totals[result]++;
    await onProgress?.(result,error.status);
    if ([401,429].includes(error.status)) throw error;
   }
   if (item) {
    await saveDictionary(pool,space,source,[item],startedAt);
    byId.set(property,item);
    totals.ok++;
    await onProgress?.("ok",200);
   }
  }
 }
 for (const property of byId.values()) {
  const type=String(property.type??"").toLowerCase();
  const endpoints=type==="select"?["select-values"]:type==="catalog"?["catalog-values"]:property.id==="428033"?["select-values","catalog-values"]:[];
  for (const endpoint of endpoints) await load(endpoint+":"+property.id,
   "/company/custom-properties/"+property.id+"/"+endpoint,"offset",x=>entity(x,[...common,"value"],{property_id:property.id}),{},true);
 }
 for (const board of boards??[]) {
  const parent={board_id:board.id};
  const columns=await load("columns:"+board.id,"/boards/"+board.id+"/columns","single",x=>entity(x,common,parent));
  await load("lanes:"+board.id,"/boards/"+board.id+"/lanes","single",x=>entity(x,common,parent));
  for (const column of columns??[]) await load("subcolumns:"+column.id,"/columns/"+column.id+"/subcolumns","single",
   x=>entity(x,common,{...parent,column_id:column.id}));
 }
}

function difference(current,raw){
 return Object.fromEntries(Object.entries(current).filter(([key,value])=>!isDeepStrictEqual(value,raw[key])));
}

function cardSources(card,api){
 const base="/cards/"+requireId(card.id);
 const raw=card.data;
 const embedded={};
 let detailResponse;
 async function detail(){
  detailResponse ??= (await api.get(base,{broken_api:false})).data;
  if (!isObject(detailResponse)||requireId(detailResponse.id)!==card.id) throw new Error("Unexpected Kaiten card");
  return detailResponse;
 }
 const checklists=lists=>lists.map(entry=>({...entity(entry,["name","title"]),
  items:entry.items.map(item=>entity(item,["text","checked","checked_at","card_id"]))}));
 const roles=rows=>rows.map(x=>({id:requireId(x.user_id??x.id),...allowed(x,["type","role_id","responsible"])}));
 const linkRows=rows=>rows.map(x=>entity(x,["url","description","created","updated"]));
 const blockerRows=rows=>rows.map(x=>entity(x,
  ["reason","category_id","blocker_id","blocker_card_id","released","created","updated","released_at"]));
 return {embedded,
  detail:async()=>{
   const data=await detail();
   if (!Object.hasOwn(data,"description")) throw new Error("Unexpected Kaiten card");
   const result=difference(allowed(data,["description","description_type"]),raw);
   if (Array.isArray(data.members)&&data.members.every(x=>x && apiId(x.user_id??x.id)&&[1,2].includes(x.type)))
    embedded.members=roles(data.members);
   if (Array.isArray(data.tag_ids)) {
    const ids=idList(data.tag_ids);
    embedded.tags=isDeepStrictEqual(ids,idList(raw.tag_ids))?[]:ids;
   }
   if (Array.isArray(data.children_ids)) {
    const ids=idList(data.children_ids);
    embedded.children=isDeepStrictEqual(ids,idList(raw.children_ids))?[]:ids;
   }
   if (Array.isArray(data.external_links)&&data.external_links.every(x=>apiId(x?.id))) embedded.links=linkRows(data.external_links);
   const properties=isObject(data.properties)?difference(data.properties,raw.properties??{}):null;
   if (properties&&Object.keys(properties).length) result.properties=properties;
   if (Array.isArray(data.parents_ids)&&!isDeepStrictEqual(idList(data.parents_ids),idList(raw.parents_ids))) result.parents_ids=idList(data.parents_ids);
   if (Array.isArray(data.checklists)) {
    if (data.checklists.every(entry=>Array.isArray(entry.items)))
     embedded.checklists=isDeepStrictEqual(data.checklists,raw.checklists)?[]:checklists(data.checklists);
    else result.checklist_refs=data.checklists.map(entry=>requireId(entry.id));
   }
   return result;
  },
  members:async()=>roles(await api.list(base+"/members")).filter(x=>Object.keys(x).length>1),
  tags:async()=>{
   const ids=idList(await api.list(base+"/tags"));
   return isDeepStrictEqual(ids,idList(raw.tag_ids))?[]:ids;
  },
  children:async()=>{
   const ids=idList(await api.list(base+"/children","offset",{broken_api:false}));
   return isDeepStrictEqual(ids,idList(raw.children_ids))?[]:ids;
  },
  checklists:async()=>{
   const refs=card.detail_payload?.checklist_refs;
   if (Array.isArray(refs)) {
    const entries=[];
    for (const id of refs) entries.push((await api.get(base+"/checklists/"+requireId(id))).data);
    return checklists(entries);
   }
   if (!Array.isArray((await detail()).checklists)) throw new Error("Checklist field unavailable");
   const entries=[];
   for (const list of detailResponse.checklists)
    entries.push(Array.isArray(list.items)?list:(await api.get(base+"/checklists/"+requireId(list.id))).data);
   return checklists(entries);
  },
  links:async()=>linkRows(await api.list(base+"/external-links")),
  blockers:async()=>blockerRows(await api.list(base+"/blockers","offset",{broken_api:false})),
  comments:async()=>(await api.list(base+"/comments","offset")).map(x=>entity(x,["text","created","updated","author_id","type"]))
 };
}

export async function refreshCardSources({pool,space,api,totals,mode,limit,cardId,ids=[],sources=CARD_SOURCES,checkpoint,signal,onProgress,force=false}){
 const {rows}=await pool.query(`WITH candidates AS(
  SELECT id::text, id AS numeric_id,data,updated_at
  FROM kaiten_cards WHERE space_id=$1 AND ($4::bigint IS NULL OR id=$4)
   AND (cardinality($6::bigint[])=0 OR id=ANY($6::bigint[]))
 ), source_keys AS (SELECT unnest($5::text[]) AS source)
 SELECT c.id,c.data,c.updated_at,d.payload AS detail_payload,COALESCE(extract(epoch FROM c.updated_at)::text,'') AS version,array_agg(s.source ORDER BY (s.source<>'detail'),s.source) AS sources
 FROM candidates c CROSS JOIN source_keys s LEFT JOIN kaiten_enrichment_sources e
 ON e.space_id=$1 AND e.subject=c.id AND e.source=s.source
 LEFT JOIN kaiten_enrichment_sources d ON d.space_id=$1 AND d.subject=c.id AND d.source='detail'
 AND d.source_version=COALESCE(extract(epoch FROM c.updated_at)::text,'') AND d.last_success_at IS NOT NULL
 WHERE ($7::timestamptz IS NULL OR e.last_attempt_at IS NULL OR e.last_attempt_at<$7) AND (
  ($2='initial' AND (e.last_success_at IS NULL OR e.result NOT IN ('ok','empty')))
  OR ($2='pending' AND (e.last_success_at IS NULL OR e.result NOT IN ('ok','empty')
   OR e.source_version IS DISTINCT FROM COALESCE(extract(epoch FROM c.updated_at)::text,'')))
  OR ($2='errors' AND e.result IN ('error','forbidden','not_found'))
  OR $4::bigint IS NOT NULL OR $8::boolean)
 GROUP BY c.id,c.numeric_id,c.data,c.updated_at,d.payload
 ORDER BY min(e.last_attempt_at) NULLS FIRST,c.numeric_id LIMIT $3`,[space,mode,limit,cardId,sources,ids,checkpoint??null,force]);
 for (const card of rows) {
  const operations=cardSources(card,api);
  for (const source of card.sources) {
   signal?.throwIfAborted();
   if (source!=="detail"&&Object.hasOwn(operations.embedded,source)) continue;
   await storageCheck(pool);
   const startedAt=new Date();
   let payload;
   try {
    payload=await operations[source]();
    if (Buffer.byteLength(JSON.stringify(payload))>PAYLOAD_LIMIT) throw new Error("Source payload too large");
   } catch(error){
    if (signal?.aborted||error.budget) throw error;
    const result=apiStatus(error);
    await writeState(pool,{space,subject:card.id,source,startedAt,result,payload:null,status:error.status??null});
    totals[result]++;
    await onProgress?.(result,error.status,source);
    if ([401,429].includes(error.status)) throw error;
    continue;
   }
   const result=Object.keys(payload).length?"ok":"empty";
   await writeState(pool,{space,subject:card.id,source,startedAt,result,payload,
    version:card.version,status:200});
   totals[result]++;
   await onProgress?.(result,200,source);
   if (source==="detail") {
    for (const [key,value] of Object.entries(operations.embedded)) {
     if (Buffer.byteLength(JSON.stringify(value))>PAYLOAD_LIMIT) {
      delete operations.embedded[key];
      continue;
     }
     await storageCheck(pool);
     const kind=value.length?"ok":"empty";
     await writeState(pool,{space,subject:card.id,source:key,startedAt,result:kind,payload:value,version:card.version,status:200});
     totals[kind]++;
     await onProgress?.(kind,200,key);
    }
   }
  }
 }
 return rows.length;
}

export async function runEnrichment({pool,config,mode,limit=25,cardId=null,fetcher,wait,ids,sources,checkpoint,signal,onProgress,force,maxRequests=1200,onlyErrors=false}){
 const lock=await pool.connect();
 let acquired=false, discard=false;
 const totals={ok:0,empty:0,forbidden:0,not_found:0,error:0};
 const space=requireId(config.spaceId);
 const api=makeEnrichmentApi({config,fetcher,wait,maxRequests,signal});
 try {
  acquired=(await lock.query("SELECT pg_try_advisory_lock($1) AS acquired",[HISTORY_LOCK])).rows[0].acquired;
  if (!acquired) return {skipped:true};
  await storageCheck(pool);
  if (mode==="dictionaries") await refreshDictionaries({pool,space,api,totals,checkpoint,signal,onProgress,onlyErrors});
  else if (["initial","pending","errors"].includes(mode)) totals.cards=await refreshCardSources({pool,space,api,totals,mode,limit,cardId,ids,sources,checkpoint,signal,onProgress,force});
  else throw new Error("Invalid enrichment mode");
  return {...totals,requests:api.count()};
 } finally {
  if (acquired) {
   try {await lock.query("SELECT pg_advisory_unlock($1)",[HISTORY_LOCK]);}
   catch {discard=true;}
  }
  lock.release(discard);
 }
}
