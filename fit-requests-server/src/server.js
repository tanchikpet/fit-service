import http from "node:http";
import {readFile} from "node:fs/promises";
import {timingSafeEqual} from "node:crypto";
import {loadConfig} from "./config.js";
import {makeDb,setupDb} from "./db.js";
import {makeSync} from "./sync.js";
import {initAuth,telegramAuth} from "./auth.js";
import {initBotAuth,makeBotLogin} from "./bot-login.js";
import {initRequests,listRequests,createRequest,updateRequest,importRequests} from "./requests.js";
const config=loadConfig();const pool=makeDb(config.databaseUrl);
await setupDb(pool);
await initAuth(pool);
await initBotAuth(pool);
await initRequests(pool);
const sync=makeSync({pool,config});
const auth=telegramAuth({pool});
const botLogin=makeBotLogin({pool});
const safeEqual=(a,b)=>{const x=Buffer.from(String(a||"")),y=Buffer.from(String(b||""));return x.length===y.length&&timingSafeEqual(x,y)};
function send(res,status,value){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"});res.end(JSON.stringify(value))}
function authorized(req){return safeEqual(req.headers.authorization,"Bearer "+config.adminToken)}
function sameOrigin(req){return Boolean(process.env.PUBLIC_ORIGIN)&&req.headers.origin===process.env.PUBLIC_ORIGIN}
const escapeHtml=x=>String(x??"").replace(/[&<>"\x27]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","\x27":"&#39;"}[c]));
function html(res,status,body){res.writeHead(status,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'none';style-src 'unsafe-inline';form-action 'self';base-uri 'none';frame-ancestors 'none'","X-Frame-Options":"DENY","X-Content-Type-Options":"nosniff"});res.end(body)}
const shell=(content)=>`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FIT Requests</title><style>*{box-sizing:border-box}body{margin:0;background:#f7f8fa;color:#27303a;font:14px system-ui,Arial,sans-serif}header{background:#15191f;color:#fff;padding:18px 5%;display:flex;justify-content:space-between;gap:14px;align-items:center}.logo{font-weight:800;font-size:20px}.logo b{color:#fe5000}main{max-width:1160px;margin:32px auto;padding:0 16px}.card{background:#fff;border:1px solid #e4e7ec;border-radius:14px;padding:24px;margin:18px 0}.muted{color:#747e89}a,.button{color:#fe5000}.button{display:inline-block;background:#fe5000;color:#fff;text-decoration:none;border:0;border-radius:9px;padding:11px 17px;font-weight:700;cursor:pointer}.toolbar{display:flex;gap:12px;align-items:center}.tablewrap{overflow:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:13px;border-bottom:1px solid #eef0f3;max-width:470px}th{color:#7b8390;font-size:11px}input{padding:10px;border:1px solid #d9dfe6;border-radius:8px}@media(max-width:600px){header{padding:12px}main{margin:18px auto}.card{padding:15px}td,th{padding:8px}}</style></head><body>${content}</body></html>`;
async function dashboard(user){const cards=await pool.query("SELECT id,title,state,updated_at FROM kaiten_cards WHERE space_id=$1 ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT 100",[config.spaceId]);const count=await pool.query("SELECT count(*)::int AS n FROM kaiten_cards WHERE space_id=$1",[config.spaceId]);const syncState=await pool.query("SELECT last_success_at,last_error FROM kaiten_sync_state WHERE space_id=$1",[config.spaceId]);const t=syncState.rows[0];const admin=user.role==="admin"?`<section class="card"><h2>Доступ сотрудников</h2><p class="muted">Приглашение доступно только администратору. Проверяй Telegram ID сотрудника до выдачи доступа.</p><form method="post" action="/auth/invite"><input required pattern="[0-9]{4,20}" name="telegram_id" placeholder="Telegram ID сотрудника" inputmode="numeric"><button type="submit" class="button">Пригласить</button></form></section>`:"";const rows=cards.rows.map(c=>`<tr><td>${escapeHtml(c.id)}</td><td>${escapeHtml(c.title)}</td><td>${escapeHtml(c.state??"—")}</td><td>${escapeHtml(c.updated_at?new Date(c.updated_at).toLocaleString("ru-RU"):"—")}</td></tr>`).join("");return shell(`<header><div class="logo">F<b>.</b> FIT Requests</div><div class="toolbar">${escapeHtml(user.display_name||user.telegram_id)} · ${user.role==="admin"?"Администратор":"Сотрудник"} <form action="/auth/logout" method="post"><button class="button" type="submit">Выйти</button></form></div></header><main><h1>Задачи Kaiten</h1><p class="muted">Защищенный просмотр синхронизированных задач. Старый прототип заявок пока работает отдельно.</p><section class="card"><b>Всего карточек: ${count.rows[0].n}</b><p>Последняя синхронизация: ${escapeHtml(t?.last_success_at?new Date(t.last_success_at).toLocaleString("ru-RU"):"нет данных")}</p>${t?.last_error?`<p class="muted">Последняя ошибка: ${escapeHtml(t.last_error)}</p>`:""}</section><section class="card"><h2>Последние 100 обновленных карточек</h2><div class="tablewrap"><table><thead><tr><th>ID</th><th>Название</th><th>Статус</th><th>Обновлено</th></tr></thead><tbody>${rows}</tbody></table></div></section>${admin}</main>`)}
function collect(req,max=65536){return new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on("data",b=>{size+=b.length;if(size>max){reject(Error("body-too-large"));req.destroy()}else chunks.push(b)});req.on("end",()=>resolve(Buffer.concat(chunks).toString("utf8")));req.on("error",reject)})}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url||"/","http://localhost");
 const path=url.pathname;
 try{
  if(path==="/healthz"&&req.method==="GET"){send(res,200,{ok:true});return}
  if(path==="/auth/start"&&req.method==="GET"){res.writeHead(303,{Location:"/auth/bot/start","Cache-Control":"no-store"});res.end();return}
  if(path==="/auth/bot/start"&&req.method==="GET"){await botLogin.create(req,res);return}
  if(path==="/auth/bot/wait"&&req.method==="GET"){await botLogin.wait(req,res);return}
  if(path==="/auth/callback"&&req.method==="GET"){await auth.callback(req,res,url);return}
  if(path==="/auth/logout"&&req.method==="POST"){if(!sameOrigin(req)){send(res,403,{error:"forbidden"});return}await auth.logout(req,res);return}
  if(path==="/auth/invite"&&req.method==="POST"){if(!sameOrigin(req)){send(res,403,{error:"forbidden"});return}const body=await collect(req,2048);await auth.invite(req,res,new URLSearchParams(body).get("telegram_id"));return}
  if(path==="/"&&req.method==="GET"){const me=await auth.user(req);if(me){res.writeHead(303,{Location:"/app","Cache-Control":"no-store"});res.end();return}html(res,200,shell(`<main><section class="card" style="max-width:520px;margin:10vh auto;text-align:center"><h1>F. FIT Requests</h1><p class="muted">Закрытый доступ для приглашенных пользователей</p><a class="button" href="/auth/bot/start">Войти через Telegram-бота</a></section></main>`));return}
  if(path==="/app"&&req.method==="GET"){
    const me=await auth.user(req);if(!me){res.writeHead(303,{Location:"/","Cache-Control":"no-store"});res.end();return}
    const content=await readFile(new URL("../public/ui/index.html",import.meta.url));
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'","X-Frame-Options":"DENY","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"});res.end(content);return
  }
  if(path==="/app/kaiten"&&req.method==="GET"){
    const me=await auth.user(req);if(!me){res.writeHead(303,{Location:"/","Cache-Control":"no-store"});res.end();return}
    html(res,200,await dashboard(me));return
  }
  if(path.startsWith("/ui/")&&req.method==="GET"){
    const me=await auth.user(req);if(!me){send(res,401,{error:"unauthorized"});return}
    const asset=path.slice(4),mime={"app.js":"application/javascript; charset=utf-8","intake.js":"application/javascript; charset=utf-8","server-bridge.js":"application/javascript; charset=utf-8","style.css":"text/css; charset=utf-8","intake.css":"text/css; charset=utf-8","favicon.svg":"image/svg+xml"}[asset];
    if(!mime){send(res,404,{error:"not_found"});return}
    const content=await readFile(new URL("../public/ui/"+asset,import.meta.url));
    res.writeHead(200,{"Content-Type":mime,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"});res.end(content);return
  }
  if(path==="/webhooks/telegram"&&req.method==="POST"){
   const proof=String(req.headers["x-telegram-bot-api-secret-token"]||"");
   if(!botLogin.acceptWebhook(proof)){send(res,403,{error:"forbidden"});return}
   const raw=await collect(req,65536);let update;try{update=JSON.parse(raw)}catch{send(res,400,{error:"invalid_json"});return}
   if(!update||typeof update!=="object"||Array.isArray(update)||!Number.isSafeInteger(update.update_id)){send(res,400,{error:"invalid_update"});return}
   await botLogin.handle(update);send(res,200,{ok:true});return
  }
  if(path.startsWith("/webhooks/kaiten/")&&req.method==="POST"){
   const supplied=path.slice("/webhooks/kaiten/".length);
   if(!safeEqual(supplied,config.webhookSecret)){send(res,404,{error:"not_found"});return}
   const body=await collect(req);
   let event;try{event=JSON.parse(body)}catch{send(res,400,{error:"invalid_json"});return}
   if(!event||typeof event!=="object"||Array.isArray(event)){send(res,400,{error:"invalid_event"});return}
   // Webhooks only trigger authenticated API reads. Event contents are not trusted or written to DB.
   sync.schedule();send(res,202,{accepted:true});return
  }
  if(!path.startsWith("/api/")){send(res,404,{error:"not_found"});return}
  const me=await auth.user(req);
  if(!me&&!authorized(req)){send(res,401,{error:"unauthorized"});return}
  if(path==="/api/me"&&req.method==="GET"){if(!me){send(res,401,{error:"unauthorized"});return}send(res,200,{telegramId:me.telegram_id,displayName:me.display_name,role:me.role});return}
  if(path==="/api/requests"&&req.method==="GET"){if(!me){send(res,401,{error:"unauthorized"});return}send(res,200,await listRequests(pool,me));return}
  if(path==="/api/requests"&&req.method==="POST"){
    if(!me){send(res,401,{error:"unauthorized"});return}if(!sameOrigin(req)){send(res,403,{error:"bad_origin"});return}
    const raw=await collect(req);let body;try{body=JSON.parse(raw)}catch{send(res,400,{error:"Неверный JSON"});return}
    try{send(res,201,{item:await createRequest(pool,me,body)})}catch(err){send(res,400,{error:err.message})}return
  }
  if(path.startsWith("/api/requests/")&&req.method==="PUT"){
    if(!me){send(res,401,{error:"unauthorized"});return}if(!sameOrigin(req)){send(res,403,{error:"bad_origin"});return}
    const id=decodeURIComponent(path.slice("/api/requests/".length));const raw=await collect(req);let body;try{body=JSON.parse(raw)}catch{send(res,400,{error:"Неверный JSON"});return}
    try{const item=await updateRequest(pool,me,id,body);if(item.notFound)send(res,404,{error:"Заявка не найдена"});else if(item.forbidden)send(res,403,{error:"Нет доступа"});else if(item.conflict)send(res,409,{error:"Заявка изменена в другой вкладке. Обнови страницу."});else send(res,200,{item})}
    catch(err){send(res,400,{error:err.message})}return
  }
  if(path==="/api/requests/import"&&req.method==="POST"){
    if(!me||me.role!=="admin"){send(res,403,{error:"Нет доступа"});return}if(!sameOrigin(req)){send(res,403,{error:"bad_origin"});return}
    const raw=await collect(req,5242880);let body;try{body=JSON.parse(raw)}catch{send(res,400,{error:"Неверный JSON"});return}
    try{send(res,200,await importRequests(pool,me,body))}catch(err){send(res,400,{error:err.message})}return
  }
  if(path==="/api/sync/status"&&req.method==="GET"){
   const {rows}=await pool.query("SELECT space_id,last_success_at,last_started_at,last_error,cards_seen,pages_seen FROM kaiten_sync_state WHERE space_id=$1",[config.spaceId]);
   send(res,200,{spaceId:config.spaceId,state:rows[0]||null});return
  }
  if(path==="/api/cards"&&req.method==="GET"){
   const u=new URL(req.url,"http://localhost");const limit=Math.min(100,Math.max(1,Number(u.searchParams.get("limit"))||50)),offset=Math.min(100000,Math.max(0,Number(u.searchParams.get("offset"))||0));
   const result=await pool.query(`SELECT id,title,board_id,column_id,lane_id,state,archived,owner_id,member_ids,estimate_raw,estimate_unit,estimate_text,spent_raw,children_count,children_done,updated_at,synced_at
    FROM kaiten_cards WHERE space_id=$1 ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT $2 OFFSET $3`,[config.spaceId,limit,offset]);
   send(res,200,{items:result.rows,limit,offset});return
  }
  if(path==="/api/sync"&&req.method==="POST"){
   if(!authorized(req)){send(res,403,{error:"forbidden"});return}
   // manual sync as a protected administrative operation
   const result=await sync.run("manual");send(res,200,result);return
  }
  send(res,404,{error:"not_found"});
 }catch(e){console.error("Request failed:",e.message);if(!res.headersSent)send(res,500,{error:"internal_error"})}
});
server.headersTimeout=15000;server.requestTimeout=20000;
server.listen(config.port,"0.0.0.0",()=>{
 console.info("FIT Requests sync server started",{port:config.port,spaceId:config.spaceId});
 // Failures are visible in logs/status; startup does not block serving health endpoint.
 sync.run("startup").catch(()=>{});
 botLogin.configureWebhook().catch(err=>console.error("Telegram webhook configuration failed:",err.message));
});
const timer=setInterval(()=>sync.run("scheduled").catch(()=>{}),config.intervalMs);
async function shutdown(){clearInterval(timer);server.close();await pool.end();process.exit(0)}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
