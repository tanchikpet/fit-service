// FIT Requests: PostgreSQL-backed request service. Never trust permissions or IDs supplied by the browser.
const baseFields=["title","description","project","requester","department","onBehalf","goal","desiredDue","materials","express","pageAction","plannedUrl","actualUrl","pagePurpose","pageOwner","promotionEnd","redirectTo","mode","type","priority","status","assignee","due","kaiten","created","start","updatedAt"];
const pmFields=["type","priority","status","assignee","due","kaiten"];
const urls=["materials","express","plannedUrl","actualUrl","redirectTo","kaiten"];
const statuses=new Set(["Черновик","Новая","Уточнение","Запланирована","Разработка","Тестирование","Демо","Готово"]);
const maxLengths={title:150,description:10000,project:80,requester:120,department:100,onBehalf:120,goal:4000,desiredDue:20,materials:2048,express:2048,pageAction:40,plannedUrl:2048,actualUrl:2048,pagePurpose:1000,pageOwner:120,promotionEnd:20,redirectTo:2048,mode:20,type:80,priority:40,status:60,assignee:120,due:20,kaiten:2048,created:40,start:40,updatedAt:40};
const validDate=v=>!v||/^\d{4}-\d{2}-\d{2}$/.test(v);
function inputPayload(input,role,{draft=false,legacy=false}={}){
 if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Неверный формат заявки");
 const payload={};
 for(const key of baseFields){
  if(input[key]===undefined||input[key]===null)continue;
  if(typeof input[key]!=="string"||input[key].length>maxLengths[key])throw new Error("Неверное поле: "+key);
  payload[key]=input[key].trim();
 }
 for(const key of urls){const v=payload[key];if(!v)continue;try{const u=new URL(v);if(!["https:","http:"].includes(u.protocol)||u.username||u.password)throw Error()}catch{throw new Error("Неверная ссылка: "+key)}}
 for(const key of ["due","desiredDue","promotionEnd"]){if(!validDate(payload[key]))throw new Error("Неверная дата: "+key)}
 if(!["employee","pm"].includes(payload.mode))payload.mode="employee";
 if(role!=="admin"){payload.mode="employee";for(const key of pmFields)delete payload[key]}
 if(payload.status&&!statuses.has(payload.status))throw new Error("Неверный статус");
 if(!legacy&&!draft&&(!payload.title||(payload.mode!=="pm"&&(!payload.description||!payload.requester))))throw new Error("Для подачи укажи название, описание и инициатора");
 if(payload.pageAction&&!["new","close"].includes(payload.pageAction))throw new Error("Неверное действие со страницей");
 return payload;
}
function extractKaitenId(link){
 if(!link)return null;
 try{const u=new URL(link);if(u.protocol!=="https:"||!u.hostname.endsWith(".kaiten.ru"))return null;
 const m=u.pathname.match(/\/(?:card|cards)\/(\d+)(?:\/|$)/);return m?m[1]:null}catch{return null}
}
function toOutput(r){
 const v={...r.payload,id:r.id,revision:r.revision,createdBy:r.created_by,created:r.payload.created||r.created_at?.toISOString?.().slice(0,10),updatedAt:r.updated_at};
 v.kaitenCards=[];
 if(r.card_id){v.kaitenSync={id:r.card_id,title:r.card_title,state:r.card_state,updatedAt:r.card_updated_at,estimateRaw:r.estimate_raw,estimateUnit:r.estimate_unit,estimateText:r.estimate_text,memberIds:r.member_ids}}
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
 // Migrate only resolvable legacy single-card references. Do not copy unverified URLs.
 await pool.query(`INSERT INTO fit_request_kaiten_links(request_id,card_id,linked_by)
 SELECT r.id,r.kaiten_card_id,r.updated_by FROM fit_requests r
 JOIN kaiten_cards k ON k.id=r.kaiten_card_id
 WHERE r.kaiten_card_id IS NOT NULL
 ON CONFLICT(request_id,card_id) DO NOTHING`);
}
const select=`SELECT r.id,r.payload,r.created_by,r.updated_by,r.revision,r.created_at,r.updated_at,
 k.id AS card_id,k.title AS card_title,k.state AS card_state,k.updated_at AS card_updated_at,k.estimate_raw,k.estimate_unit,k.estimate_text,k.member_ids
 FROM fit_requests r LEFT JOIN kaiten_cards k ON k.id=r.kaiten_card_id`;
const roleFilter=user=>user.role==="admin"?"": " WHERE r.created_by=$1";
const cardFields=`SELECT l.request_id, k.id::text AS id,k.title,k.state,k.updated_at,k.member_ids,k.owner_id,
 k.estimate_raw,k.estimate_unit,k.estimate_text,k.spent_raw,k.column_id,k.board_id,k.synced_at,
 l.linked_at,l.linked_by FROM fit_request_kaiten_links l
 JOIN kaiten_cards k ON k.id=l.card_id`;
function cardOutput(r){return {id:r.id,title:r.title,state:r.state,updatedAt:r.updated_at,memberIds:r.member_ids,ownerId:r.owner_id,estimateRaw:r.estimate_raw,estimateUnit:r.estimate_unit,estimateText:r.estimate_text,spentRaw:r.spent_raw,columnId:r.column_id,boardId:r.board_id,syncedAt:r.synced_at,linkedAt:r.linked_at,linkedBy:r.linked_by,url:"https://rossko.kaiten.ru/space/"+encodeURIComponent(r.board_id||"")+"/card/"+encodeURIComponent(r.id)}}
export async function listRequests(pool,user){
 const params=user.role==="admin"?[]:[user.telegram_id];
 const q=await pool.query(select+roleFilter(user)+" ORDER BY r.updated_at DESC,r.id DESC LIMIT 3000",params);
 const items=q.rows.map(toOutput),byId=new Map(items.map(t=>[t.id,t]));
 if(items.length){
  const linked=await pool.query(cardFields+" WHERE l.request_id=ANY($1::text[]) ORDER BY l.linked_at,k.id",[items.map(t=>t.id)]);
  for(const row of linked.rows){const item=byId.get(row.request_id);if(item)item.kaitenCards.push(cardOutput(row))}
 }
 return {items,limit:3000};
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
export async function updateKaitenLink(pool,user,requestId,cardId,action){
 if(user.role!=="admin")return {forbidden:true};
 if(!/^REQ-\d{1,12}$/.test(requestId)||!/^\d{1,16}$/.test(String(cardId)))throw Error("Неверный ID заявки или карточки");
 if(!["link","unlink"].includes(action))throw Error("Неверное действие");
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const request=await client.query("SELECT id FROM fit_requests WHERE id=$1 FOR UPDATE",[requestId]);
  if(!request.rows.length){await client.query("ROLLBACK");return {notFound:true}}
  if(action==="link"){
   const exists=await client.query("SELECT id FROM kaiten_cards WHERE id=$1 AND space_id=$2",[cardId,process.env.KAITEN_SPACE_ID]);
   if(!exists.rows.length){await client.query("ROLLBACK");return {cardNotFound:true}}
   await client.query("INSERT INTO fit_request_kaiten_links(request_id,card_id,linked_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[requestId,cardId,user.telegram_id]);
  }else{
   await client.query("DELETE FROM fit_request_kaiten_links WHERE request_id=$1 AND card_id=$2",[requestId,cardId]);
  }
  await client.query("INSERT INTO fit_requests_audit(request_id,editor_id,action,revision,payload) SELECT id,$2,$3,revision,$4::jsonb FROM fit_requests WHERE id=$1",[requestId,user.telegram_id,action==="link"?"kaiten_link":"kaiten_unlink",JSON.stringify({cardId:String(cardId)})]);
  await client.query("COMMIT");return {ok:true};
 }catch(err){await client.query("ROLLBACK");throw err}finally{client.release()}
}
export async function createRequest(pool,user,body){
 const isDraft=body.status==="Черновик";
 const payload=inputPayload(body,user.role,{draft:isDraft});
 if(user.role!=="admin"){payload.status=isDraft?"Черновик":"Новая"}
 const client=await pool.connect();try{
 await client.query("BEGIN");
 const id="REQ-"+(await client.query("SELECT nextval('fit_request_seq') AS n")).rows[0].n;
 const q=await client.query("INSERT INTO fit_requests(id,payload,created_by,updated_by,kaiten_card_id) VALUES($1,$2::jsonb,$3,$3,$4) RETURNING *",[id,JSON.stringify({...payload,created:new Date().toISOString().slice(0,10)}),user.telegram_id,extractKaitenId(payload.kaiten)]);
 await client.query("INSERT INTO fit_requests_audit(request_id,editor_id,action,revision,payload) VALUES($1,$2,'create',1,$3::jsonb)",[id,user.telegram_id,JSON.stringify(q.rows[0].payload)]);
 await client.query("COMMIT");return toOutput(q.rows[0]);
 }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
}
export async function updateRequest(pool,user,id,body){
 if(!/^REQ-[0-9]{1,12}$/.test(id))throw Error("Неверный ID");
 const revision=body.revision;
 if(!Number.isSafeInteger(revision)||revision<1)throw Error("Требуется версия заявки");
 const payload=inputPayload(body,user.role,{draft:body.status==="Черновик"});
 const client=await pool.connect();try{
 await client.query("BEGIN");
 const cur=await client.query("SELECT * FROM fit_requests WHERE id=$1 FOR UPDATE",[id]);
 if(!cur.rows.length){await client.query("ROLLBACK");return {notFound:true}}
 const old=cur.rows[0];
 if(user.role!=="admin"&&old.created_by!==user.telegram_id){await client.query("ROLLBACK");return {forbidden:true}}
 if(old.revision!==revision){await client.query("ROLLBACK");return {conflict:true,currentRevision:old.revision}}
 if(user.role!=="admin"){for(const f of pmFields){if(old.payload[f]!==undefined)payload[f]=old.payload[f];else delete payload[f]}
 payload.mode=old.payload.mode||"employee";payload.status=old.payload.status==="Черновик"?(body.status==="Черновик"?"Черновик":"Новая"):old.payload.status}
 const merged={...old.payload,...payload,id:undefined};
 delete merged.id;delete merged.revision;delete merged.createdBy;delete merged.kaitenSync;merged.created=old.payload.created;
 const result=await client.query("UPDATE fit_requests SET payload=$2::jsonb,revision=revision+1,updated_at=now(),updated_by=$3,kaiten_card_id=$4 WHERE id=$1 RETURNING *",[id,JSON.stringify(merged),user.telegram_id,extractKaitenId(merged.kaiten)]);
 await client.query("INSERT INTO fit_requests_audit(request_id,editor_id,action,revision,payload) VALUES($1,$2,'update',$3,$4::jsonb)",[id,user.telegram_id,result.rows[0].revision,JSON.stringify(merged)]);
 await client.query("COMMIT");return toOutput(result.rows[0]);
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
 const q=await client.query("INSERT INTO fit_requests(id,payload,created_by,updated_by,kaiten_card_id,source) VALUES($1,$2::jsonb,$3,$3,$4,'import') ON CONFLICT(id) DO NOTHING RETURNING id",[it.id,JSON.stringify(it.payload),user.telegram_id,extractKaitenId(it.payload.kaiten)]);
 if(q.rowCount){imported++;await client.query("INSERT INTO fit_requests_audit(request_id,editor_id,action,revision,payload) VALUES($1,$2,'import',1,$3::jsonb)",[it.id,user.telegram_id,JSON.stringify(it.payload)])}
 else skipped++;
 }
 await client.query("SELECT setval('fit_request_seq', GREATEST((SELECT last_value FROM fit_request_seq),(SELECT COALESCE(MAX(SUBSTRING(id FROM 5)::bigint),0) FROM fit_requests)),true)");
 await client.query("COMMIT");return {imported,skipped,total:normalized.length};
 }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
}
