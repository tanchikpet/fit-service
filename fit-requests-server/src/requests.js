import {createHash} from "node:crypto";
import {requestFields, storedKind, validateRequestFields} from "../public/ui/request-fields.js";
// FIT Requests: PostgreSQL-backed request service. Never trust permissions or IDs supplied by the browser.
const baseFields=["title","description","project","requester","department","onBehalf","goal","desiredDue","materials","express","pageAction","plannedUrl","actualUrl","pagePurpose","pageOwner","promotionEnd","redirectTo","mode","type","priority","status","assignee","due","kaiten","created","start","updatedAt"];
const pmFields=["type","priority","status","assignee","due","kaiten"];
const urls=["materials","express","plannedUrl","actualUrl","redirectTo","kaiten"];
const statuses=new Set(["Черновик","Новая","Уточнение","Запланирована","Разработка","Тестирование","Демо","Готово"]);
const maxLengths={title:150,description:10000,project:80,requester:120,department:100,onBehalf:120,goal:4000,desiredDue:20,materials:2048,express:2048,pageAction:40,plannedUrl:2048,actualUrl:2048,pagePurpose:1000,pageOwner:120,promotionEnd:20,redirectTo:2048,mode:20,type:80,priority:40,status:60,assignee:120,due:20,kaiten:2048,created:40,start:40,updatedAt:40};
baseFields.push("requestKind", ...requestFields.map(f=>f[0]).filter(k=>!baseFields.includes(k)));
Object.assign(maxLengths, Object.fromEntries(requestFields.map(f=>[f[0],f[5]])), {requestKind:20});
const requestFieldKeys=new Set(requestFields.map(([key])=>key));
const requestError=(message,field)=>Object.assign(new Error(message),{status:400,field});
const employeeFields=[
 "requestKind","title","owner","plannedUrl","actualUrl","description","sourceId","promoCode",
 "cardRange","campaignId","offer","campaignStart","campaignEnd","stations","terms",
 "restrictions","otherPromotions","counter","campaignGoals","materials","goal","desiredDue","express",
 "project","requester","department","pageAction","pageOwner"
];
function employeeOutput(row){
 const item={};
 for(const key of employeeFields){
  if(typeof row.payload[key]==="string")item[key]=row.payload[key];
 }
 // Only the public stage is derived from the association. Card existence in the sync cache is irrelevant.
 const status=statuses.has(row.payload.status)?row.payload.status:"Новая";
 return {...item,id:row.id,revision:row.revision,createdBy:row.created_by,
  created:typeof row.payload.created==="string"&&row.payload.created||row.created_at?.toISOString().slice(0,10),
  updatedAt:row.updated_at,status:status!=="Черновик"&&row.kaiten_card_id!=null?"Передана в Kaiten":status};
}
const validDate=v=>!v||/^\d{4}-\d{2}-\d{2}$/.test(v);
function inputPayload(input,role,{draft=false,legacy=false}={}){
 if(!input||typeof input!=="object"||Array.isArray(input))throw requestError("Неверный формат заявки");
 const payload={};
 for(const key of baseFields){
  if(input[key]===undefined||input[key]===null)continue;
  if(typeof input[key]!=="string"||input[key].length>maxLengths[key])throw requestError("Неверное поле: "+key,key);
  payload[key]=input[key].trim();
 }
 for(const key of urls){if(!legacy&&requestFieldKeys.has(key))continue;const v=payload[key];if(!v)continue;try{const u=new URL(v);if(!["https:","http:"].includes(u.protocol)||u.username||u.password)throw Error()}catch{throw requestError("Неверная ссылка: "+key)}}
 for(const key of (legacy?["due","desiredDue","promotionEnd"]:["due","promotionEnd"])){if(!validDate(payload[key]))throw requestError("Неверная дата: "+key)}
 if(!legacy){
  // FIT Requests accepts employee requests only. PM manages clarification, not Kaiten execution.
  payload.mode="employee";
  for(const key of ["type","priority","assignee","due","kaiten"])delete payload[key];
 }
 if(role!=="admin")delete payload.status;
 if(payload.status&&!(legacy?statuses:new Set(["Черновик","Новая","Уточнение"])).has(payload.status))throw requestError("Неверный этап обработки заявки");
 if(!legacy){
  payload.requestKind=payload.requestKind||"other";
  const error=validateRequestFields(payload,{draft});if(error)throw requestError(error.message,error.key);
 }
 if(payload.pageAction&&!["new","close"].includes(payload.pageAction))throw requestError("Неверное действие со страницей");
 return payload;
}
function extractKaitenId(link){
 if(!link)return null;
 try{const u=new URL(link);if(u.protocol!=="https:"||!u.hostname.endsWith(".kaiten.ru"))return null;
 const m=u.pathname.match(/\/(?:card|cards)\/(\d+)(?:\/|$)/);return m?m[1]:null}catch{return null}
}
function toOutput(r,user){
 if(user.role!=="admin")return employeeOutput(r);
 const v={...r.payload,id:r.id,revision:r.revision,createdBy:r.created_by,created:r.payload.created||r.created_at?.toISOString?.().slice(0,10),updatedAt:r.updated_at};
 v.kaitenParent=null;
 if(r.card_id){v.kaitenParent={id:String(r.card_id),title:r.card_title,state:r.card_state,updatedAt:r.card_updated_at,estimateRaw:r.estimate_raw,estimateUnit:r.estimate_unit,estimateText:r.estimate_text,memberIds:r.member_ids,ownerId:r.owner_id,dueDate:r.card_due_date,plannedStart:r.card_planned_start,plannedEnd:r.card_planned_end,childrenCount:r.children_count,childrenDone:r.children_done}}
 return v;
}
export async function initRequests(pool){
 await pool.query(`
 CREATE SEQUENCE IF NOT EXISTS fit_request_seq START 1000;
 CREATE TABLE IF NOT EXISTS fit_requests(
 id text PRIMARY KEY,payload jsonb NOT NULL,created_by text NOT NULL,
 updated_by text NOT NULL,revision integer NOT NULL DEFAULT 1,
 kaiten_card_id bigint,source text NOT NULL DEFAULT 'app',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS fit_requests_created_by_idx ON fit_requests(created_by);
 CREATE TABLE IF NOT EXISTS fit_request_kaiten_links(
 request_id text NOT NULL REFERENCES fit_requests(id) ON DELETE CASCADE,
 card_id bigint NOT NULL REFERENCES kaiten_cards(id) ON DELETE RESTRICT,
 linked_by text NOT NULL,
 linked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(request_id,card_id)
 );
 CREATE INDEX IF NOT EXISTS fit_request_kaiten_links_card_idx ON fit_request_kaiten_links(card_id);

 CREATE TABLE IF NOT EXISTS fit_requests_audit(
 event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 request_id text NOT NULL,editor_id text NOT NULL,action text NOT NULL,
 revision integer NOT NULL,payload jsonb NOT NULL,occurred_at timestamptz NOT NULL DEFAULT now());
 `);
 // Legacy multi-links are retained for audit only; no automatic reattachment after unlink.
}
const requestColumns="SELECT r.id,r.payload,r.created_by,r.revision,r.created_at,r.updated_at,r.kaiten_card_id";
const select=`${requestColumns},
 k.id AS card_id,k.title AS card_title,k.state AS card_state,k.updated_at AS card_updated_at,k.estimate_raw,k.estimate_unit,k.estimate_text,k.member_ids,k.owner_id,k.children_count,k.children_done,k.data->>'due_date' AS card_due_date,k.data->>'planned_start' AS card_planned_start,k.data->>'planned_end' AS card_planned_end
 FROM fit_requests r LEFT JOIN kaiten_cards k ON k.id=r.kaiten_card_id`;
const selectFor=user=>user.role==="admin"?select:requestColumns+" FROM fit_requests r";
export async function listRequests(pool,user){
 const params=user.role==="admin"?[]:[user.telegram_id];
 const filter=params.length?" WHERE r.created_by=$1":"";
 const q=await pool.query(selectFor(user)+filter+" ORDER BY r.updated_at DESC,r.id DESC LIMIT 3000",params);
 return {items:q.rows.map(row=>toOutput(row,user)),limit:3000};
}
export async function searchKaitenCards(pool,user,search){
 if(user.role!=="admin")throw Error("Нет доступа к поиску карточек");
 const q=String(search||"").trim();if(q.length<2||q.length>120)throw Error("Для поиска укажи минимум два символа");
 const numeric=/^\d{1,16}$/.test(q);
 const result=await pool.query(`SELECT id::text AS id,title,state,board_id,column_id,estimate_text,updated_at
 FROM kaiten_cards WHERE space_id=$1 AND (title ILIKE $2 OR id::text=$3)
 ORDER BY CASE WHEN id::text=$3 THEN 0 ELSE 1 END,updated_at DESC NULLS LAST LIMIT 20`,[process.env.KAITEN_SPACE_ID,"%"+q.replace(/[\\%_]/g,"\\$&")+"%",numeric?q:"0"]);
 return {items:result.rows};
}
export async function updateKaitenParent(pool,user,requestId,cardId,action){
 if(user.role!=="admin")return {forbidden:true};
 if(!/^REQ-\d{1,12}$/.test(requestId)||!["link","unlink"].includes(action))throw Error("Неверные параметры");
 if(!/^\d{1,16}$/.test(String(cardId||"")))throw Error("Неверный ID карточки");
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const q=await client.query("SELECT kaiten_card_id,payload FROM fit_requests WHERE id=$1 FOR UPDATE",[requestId]);
  if(!q.rows.length){await client.query("ROLLBACK");return {notFound:true}}
  if(action==="link"&&q.rows[0].payload.status==="Черновик"){await client.query("ROLLBACK");return {draft:true}}
  const current=q.rows[0].kaiten_card_id;
  if(action==="link"){
   if(current&&String(current)!==String(cardId)){await client.query("ROLLBACK");return {alreadyLinked:true}}
   const exists=await client.query("SELECT id FROM kaiten_cards WHERE id=$1 AND space_id=$2",[cardId,process.env.KAITEN_SPACE_ID]);
   if(!exists.rows.length){await client.query("ROLLBACK");return {cardNotFound:true}}
   if(!current)await client.query("UPDATE fit_requests SET kaiten_card_id=$2,updated_at=now() WHERE id=$1",[requestId,cardId]);
  }else{
   if(!current){await client.query("ROLLBACK");return {ok:true}}
   if(String(current)!==String(cardId)){await client.query("ROLLBACK");return {alreadyLinked:true}}
   await client.query("UPDATE fit_requests SET kaiten_card_id=NULL,updated_at=now() WHERE id=$1",[requestId]);
  }
  await client.query("INSERT INTO fit_requests_audit(request_id,editor_id,action,revision,payload) SELECT id,$2,$3,revision,$4::jsonb FROM fit_requests WHERE id=$1",[requestId,user.telegram_id,action==="link"?"kaiten_parent_link":"kaiten_parent_unlink",JSON.stringify({cardId:String(cardId)})]);
  await client.query("COMMIT");return {ok:true};
 }catch(err){await client.query("ROLLBACK");throw err}finally{client.release()}
}
export async function getKaitenParentId(pool,user,requestId){
 if(user.role!=="admin"||!/^REQ-\d{1,12}$/.test(requestId))return null;
 const q=await pool.query("SELECT kaiten_card_id FROM fit_requests WHERE id=$1",[requestId]);
 return q.rows.length?q.rows[0].kaiten_card_id:null;
}
// Keep successful mutation keys in the existing audit trail, including after deletion.
function mutation(body){
 if(body?.operationId===undefined)return null;
 if(typeof body.operationId!=="string"||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(body.operationId))throw requestError("Неверный ключ сохранения");
 const {operationId,...input}=body;
 const hash=createHash("sha256").update(JSON.stringify(Object.entries(input).sort(([a],[b])=>a.localeCompare(b)))).digest("hex");
 return {operationId,hash};
}
async function replay(client,user,key,action,id=null){
 if(!key)return null;
 await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[JSON.stringify([user.telegram_id,key.operationId])]);
 const result=await client.query(
  "SELECT request_id,action,payload FROM fit_requests_audit WHERE editor_id=$1 AND payload->'_mutation'->>'operationId'=$2 LIMIT 1",
  [user.telegram_id,key.operationId]);
 const event=result.rows[0];
 if(!event)return null;
 if(event.action!==action||(id&&event.request_id!==id)||event.payload._mutation.hash!==key.hash){
  throw Object.assign(Error("Эта попытка сохранения уже завершилась с другими данными. Проверь заявку в списке."),{status:409});
 }
 const current=await client.query(selectFor(user)+" WHERE r.id=$1 AND ($2='admin' OR r.created_by=$3)",[event.request_id,user.role,user.telegram_id]);
 if(!current.rows.length)throw Object.assign(Error("Заявка уже удалена"),{status:409});
 return toOutput(current.rows[0],user);
}
const auditPayload=(payload,key)=>JSON.stringify(key?{...payload,_mutation:key}:payload);

export async function createRequest(pool,user,body){
 const key=mutation(body);
 const isDraft=body?.status==="Черновик";
 const payload=inputPayload(body,user.role,{draft:isDraft});
 payload.requester=user.display_name||user.telegram_id;
 if(user.role!=="admin")payload.project="";
 payload.status=isDraft?"Черновик":"Новая";
 const client=await pool.connect();try{
 await client.query("BEGIN");
 const existing=await replay(client,user,key,"create");
 if(existing){await client.query("COMMIT");return existing}
 const id="REQ-"+(await client.query("SELECT nextval('fit_request_seq') AS n")).rows[0].n;
 const q=await client.query("INSERT INTO fit_requests(id,payload,created_by,updated_by) VALUES($1,$2::jsonb,$3,$3) RETURNING *",[id,JSON.stringify({...payload,created:new Date().toISOString().slice(0,10)}),user.telegram_id]);
 await client.query("INSERT INTO fit_requests_audit(request_id,editor_id,action,revision,payload) VALUES($1,$2,'create',1,$3::jsonb)",[id,user.telegram_id,auditPayload(q.rows[0].payload,key)]);
 await client.query("COMMIT");return toOutput(q.rows[0],user);
 }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
}
export async function updateRequest(pool,user,id,body){
 if(!/^REQ-[0-9]{1,12}$/.test(id))throw requestError("Неверный ID");
 const key=mutation(body);
 const revision=body?.revision;
 if(!Number.isSafeInteger(revision)||revision<1)throw requestError("Требуется версия заявки");

 const client=await pool.connect();try{
 await client.query("BEGIN");
 const existing=await replay(client,user,key,"update",id);
 if(existing){await client.query("COMMIT");return existing}
 const cur=await client.query("SELECT * FROM fit_requests WHERE id=$1 FOR UPDATE",[id]);
 if(!cur.rows.length){await client.query("ROLLBACK");return {notFound:true}}
 const old=cur.rows[0];
 if(user.role!=="admin"&&old.created_by!==user.telegram_id){await client.query("ROLLBACK");return {forbidden:true}}
 if(old.revision!==revision){await client.query("ROLLBACK");return {conflict:true,currentRevision:old.revision}}
 const wasDraft=old.payload.status==="Черновик";
 const draft=wasDraft&&body.status==="Черновик";
 const submitted={...old.payload,...body,requestKind:body.requestKind??storedKind(old.payload)};
 // A PM review of a legacy submitted request can still change its routing and stage.
 const legacyReview=!wasDraft&&!old.payload.requestKind&&body.requestKind===undefined&&user.role==="admin"
  &&Object.keys(body).every(key=>["revision","operationId","project","status"].includes(key));
 const payload=inputPayload(submitted,user.role,{draft,legacy:legacyReview});
 if(legacyReview)delete payload.requestKind;
 payload.requester=old.payload.requester||String(old.created_by);
 if(user.role!=="admin")payload.project=old.payload.project||"";
 for(const f of pmFields){if(old.payload[f]!==undefined)payload[f]=old.payload[f];else delete payload[f]}
 payload.mode=old.payload.mode||"employee";
 payload.status=draft?"Черновик":wasDraft?"Новая":
  user.role==="admin"&&["Новая","Уточнение"].includes(body.status)?body.status:old.payload.status;
 const merged={...old.payload,...payload,id:undefined};
 delete merged.id;delete merged.revision;delete merged.createdBy;delete merged.kaitenSync;delete merged.kaitenParent;delete merged.kaitenCards;merged.created=old.payload.created;
 const result=await client.query("UPDATE fit_requests SET payload=$2::jsonb,revision=revision+1,updated_at=now(),updated_by=$3 WHERE id=$1 RETURNING *",[id,JSON.stringify(merged),user.telegram_id]);
 await client.query("INSERT INTO fit_requests_audit(request_id,editor_id,action,revision,payload) VALUES($1,$2,'update',$3,$4::jsonb)",[id,user.telegram_id,result.rows[0].revision,auditPayload(merged,key)]);
 await client.query("COMMIT");return toOutput(result.rows[0],user);
 }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
}
export async function importRequests(pool,user,body){
 if(user.role!=="admin")throw Error("Только администратор может переносить заявки");
 const items=body?.items;if(!Array.isArray(items)||items.length>2000)throw Error("Ожидается массив не более 2000 заявок");
 const normalized=items.map(item=>{
 if(!/^REQ-[0-9]{1,12}$/.test(item?.id))throw Error("Неверный ID в файле переноса");
 const payload=inputPayload(item,"admin",{draft:item.status==="Черновик",legacy:true});
 if(!payload.title)throw Error("Отсутствует название: "+item.id);
 return {id:item.id,payload};
 });
 if(new Set(normalized.map(x=>x.id)).size!==normalized.length)throw Error("Повторяющиеся ID в файле");
 const client=await pool.connect();let imported=0,skipped=0;try{
 await client.query("BEGIN");
 for(const it of normalized){
 const q=await client.query("INSERT INTO fit_requests(id,payload,created_by,updated_by,source) VALUES($1,$2::jsonb,$3,$3,'import') ON CONFLICT(id) DO NOTHING RETURNING id",[it.id,JSON.stringify(it.payload),user.telegram_id]);
 if(q.rowCount){imported++;await client.query("INSERT INTO fit_requests_audit(request_id,editor_id,action,revision,payload) VALUES($1,$2,'import',1,$3::jsonb)",[it.id,user.telegram_id,JSON.stringify(it.payload)])}
 else skipped++;
 }
 await client.query("SELECT setval('fit_request_seq', GREATEST((SELECT last_value FROM fit_request_seq),(SELECT COALESCE(MAX(SUBSTRING(id FROM 5)::bigint),0) FROM fit_requests)),true)");
 await client.query("COMMIT");return {imported,skipped,total:normalized.length};
 }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
}

// Ownership and revision are checked under the same row lock as the deletion.
// The audit keeps the request snapshot; Kaiten cards themselves are never deleted.
export async function deleteRequest(pool,user,id,body){
 if(!/^REQ-[0-9]{1,12}$/.test(id))throw requestError("Неверный ID");
 if(!Number.isSafeInteger(body?.revision)||body.revision<1)throw requestError("Требуется версия заявки");
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const result=await client.query("SELECT * FROM fit_requests WHERE id=$1 FOR UPDATE",[id]);
  const row=result.rows[0];
  if(!row){await client.query("ROLLBACK");return {notFound:true}}
  if(String(row.created_by)!==String(user.telegram_id)){await client.query("ROLLBACK");return {forbidden:true}}
  if(row.revision!==body.revision){await client.query("ROLLBACK");return {conflict:true}}
  const attempt=await client.query("SELECT status FROM fit_kaiten_creation_attempts WHERE request_id=$1",[id]);
  if(attempt.rows[0]?.status==="pending"){await client.query("ROLLBACK");return {pending:true}}
  await client.query("INSERT INTO fit_requests_audit(request_id,editor_id,action,revision,payload) VALUES($1,$2,'delete',$3,$4::jsonb)",[id,user.telegram_id,row.revision,JSON.stringify({...row.payload,kaitenCardId:row.kaiten_card_id})]);
  await client.query("DELETE FROM fit_requests WHERE id=$1",[id]);
  await client.query("COMMIT");return {ok:true};
 }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
}
