import {normalizeCard} from "./kaiten.js";
import {upsertCards} from "./db.js";
const validId=v=>Number.isSafeInteger(Number(v))&&Number(v)>0&&String(Number(v))===String(v);
const requestIdOk=v=>/^REQ-\d{1,12}$/.test(String(v));
async function api(config,path,method="GET",body){
 const reply=await fetch(config.kaitenBase+path,{method,headers:{Authorization:"Bearer "+config.kaitenToken,Accept:"application/json",...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
 const result=await reply.json().catch(()=>null);if(!reply.ok){const error=new Error("Kaiten HTTP "+reply.status);error.status=reply.status;throw error}return result;
}
export async function initCardCreation(pool){
 await pool.query("CREATE TABLE IF NOT EXISTS fit_kaiten_creation_attempts(request_id text PRIMARY KEY REFERENCES fit_requests(id) ON DELETE CASCADE,status text NOT NULL CHECK(status IN ('pending','created','rejected')),card_id bigint,board_id bigint NOT NULL,column_id bigint NOT NULL,lane_id bigint,initiated_by text NOT NULL,initiated_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,error_code text)");
}
export async function boardCandidates(pool,config){
 const result=[];
 for(let offset=0;offset<500;offset+=100){
  const boards=await api(config,"/api/latest/spaces/"+config.spaceId+"/boards?limit=100&offset="+offset);
  if(!Array.isArray(boards))throw Error("Kaiten вернул неожиданный список досок");
  for(const b of boards){if(validId(b.id))result.push({id:String(b.id),title:String(b.title||"Доска "+b.id)})}
  if(boards.length<100)break;
 }
 return result;
}
export async function boardDetails(config,boardId){
 if(!validId(boardId))throw Error("Неверный ID доски");
 const b=await api(config,"/api/latest/spaces/"+config.spaceId+"/boards/"+Number(boardId));
 if(!b||Number(b.id)!==Number(boardId))throw Error("Доска Kaiten не найдена");
 return {id:String(b.id),title:String(b.title||"Доска "+b.id),
  columns:Array.isArray(b.columns)?b.columns.filter(c=>c.id&&c.type!==3).map(c=>({id:String(c.id),title:String(c.title||c.id)})):[],
  lanes:Array.isArray(b.lanes)?b.lanes.filter(l=>l.id&&l.condition!==3).map(l=>({id:String(l.id),title:String(l.title||"Без названия")})):[]};
}
function description(request){
 const p=request.payload;
 const lines=[["Описание",p.description],["Инициатор",p.requester],["Подразделение",p.department],["Цель",p.goal],["Желаемый срок",p.desiredDue],["Материалы",p.materials],["Обсуждение",p.express]];
 return ["Источник: FIT Requests "+request.id,...lines.filter(x=>x[1]).map(([a,b])=>a+":\n"+b)].join("\n\n").slice(0,32000);
}
export async function createParentCard(pool,config,user,requestId,body){
 if(user.role!=="admin")return {forbidden:true};
 if(!requestIdOk(requestId)||!validId(body?.boardId)||!validId(body?.columnId)||body?.laneId&&!validId(body.laneId))throw Error("Некорректная заявка или расположение карточки");
 const board=await boardDetails(config,body.boardId);
 if(!board.columns.some(c=>c.id===String(body.columnId)))throw Error("Колонка не принадлежит выбранной доске");
 if(body.laneId&&!board.lanes.some(l=>l.id===String(body.laneId)))throw Error("Дорожка не принадлежит выбранной доске");
 const tx=await pool.connect();let request;
 try{
  await tx.query("BEGIN");
  const q=await tx.query("SELECT id,payload,kaiten_card_id FROM fit_requests WHERE id=$1 FOR UPDATE",[requestId]);
  if(!q.rows.length){await tx.query("ROLLBACK");return {notFound:true}}request=q.rows[0];
  if(request.kaiten_card_id){await tx.query("ROLLBACK");return {alreadyLinked:true}}
  const previous=await tx.query("SELECT status FROM fit_kaiten_creation_attempts WHERE request_id=$1",[requestId]);
  if(previous.rows.length&&previous.rows[0].status!=="rejected"){await tx.query("ROLLBACK");return {alreadyAttempted:true,status:previous.rows[0].status}}
  if(previous.rows[0]?.status==="rejected")await tx.query("DELETE FROM fit_kaiten_creation_attempts WHERE request_id=$1 AND status=\'rejected\'",[requestId]);
  if(!request.payload.title?.trim()){await tx.query("ROLLBACK");throw Error("Не заполнено название заявки")}
  await tx.query("INSERT INTO fit_kaiten_creation_attempts(request_id,status,board_id,column_id,lane_id,initiated_by) VALUES($1,'pending',$2,$3,$4,$5)",[requestId,body.boardId,body.columnId,body.laneId||null,user.telegram_id]);
  await tx.query("COMMIT");
 }catch(e){await tx.query("ROLLBACK").catch(()=>{});throw e}finally{tx.release()}
 const payload={title:String(request.payload.title).slice(0,1024),board_id:Number(body.boardId),column_id:Number(body.columnId),description:description(request),external_id:requestId,position:2};
 if(body.laneId)payload.lane_id=Number(body.laneId);
 // Do not translate date-only deadlines into a guessed UTC time.
 let card;
 try{card=await api(config,"/api/latest/cards","POST",payload)}
 catch(e){
  if(e.status&&e.status>=400&&e.status<500){
   await pool.query("UPDATE fit_kaiten_creation_attempts SET status='rejected',error_code=$2,completed_at=now() WHERE request_id=$1",[requestId,String(e.status)]);
   return {rejected:true,error:"Kaiten отклонил карточку (HTTP "+e.status+"). Повторная отправка заблокирована для защиты от дублей."};
  }
  return {uncertain:true,error:"Не удалось установить результат отправки в Kaiten. Повторная отправка заблокирована во избежание дублей."};
 }
 if(!validId(card?.id))return {uncertain:true,error:"Kaiten не вернул ID карточки. Нужна проверка."};
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  await upsertCards(client,[normalizeCard(card,config.spaceId)]);
  const linked=await client.query("UPDATE fit_requests SET kaiten_card_id=$2,updated_at=now() WHERE id=$1 AND kaiten_card_id IS NULL RETURNING id",[requestId,card.id]);
  if(!linked.rowCount)throw Error("Заявка уже связана с карточкой");
  await client.query("UPDATE fit_kaiten_creation_attempts SET status='created',card_id=$2,completed_at=now() WHERE request_id=$1",[requestId,card.id]);
  await client.query("INSERT INTO fit_requests_audit(request_id,editor_id,action,revision,payload) SELECT id,$2,'kaiten_parent_create',revision,$3::jsonb FROM fit_requests WHERE id=$1",[requestId,user.telegram_id,JSON.stringify({cardId:String(card.id),boardId:String(body.boardId)})]);
  await client.query("COMMIT");return {ok:true,cardId:String(card.id)};
 }catch(e){await client.query("ROLLBACK").catch(()=>{});return {uncertain:true,error:"Kaiten создал карточку, но связь не подтверждена. Проверь external_id "+requestId+" перед повтором."}}
 finally{client.release()}
}
