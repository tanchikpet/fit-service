import {randomBytes,createHash,timingSafeEqual} from "node:crypto";

const key=()=>randomBytes(32).toString("base64url");
const hash=s=>createHash("sha256").update(String(s)).digest("hex");
const flowCookie="__Host-fit_bot_flow",sessionCookie="__Host-fit_session";
const cookie=(name,value,age)=>name+"="+value+"; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age="+age;
const cookies=req=>Object.fromEntries(String(req.headers.cookie||"").split(";").map(x=>x.trim()).filter(Boolean).map(x=>{const j=x.indexOf("=");return j>0?[x.slice(0,j),x.slice(j+1)]:["",""]}));
const telegramId=x=>/^\d{4,20}$/.test(String(x||""));
const textEscape=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function redirect(res,location,headers={}){res.writeHead(303,{Location:location,"Cache-Control":"no-store",...headers});res.end()}
function page(res,body,refresh=false){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Frame-Options":"DENY","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",...(refresh?{"Refresh":"3; url=/auth/bot/wait"}:{})});res.end('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FIT Requests — вход</title><link rel="icon" type="image/svg+xml" href="/ui/favicon.svg?v=brand-3"><style>body{font:15px system-ui,Arial;background:#f6f7f9;color:#1f2933;margin:0}.card{max-width:480px;margin:9vh auto;background:white;border:1px solid #e4e6ea;border-radius:16px;padding:28px;box-sizing:border-box}h1{font-size:23px}.muted{color:#66717d;line-height:1.6}.button{display:inline-block;background:#fe5000;color:white;font-weight:650;text-decoration:none;border-radius:9px;padding:13px 17px;margin:12px 0}a{color:#e84b00}@media(max-width:540px){.card{margin:16px;padding:20px}}</style></head><body><main class="card"><img src="/ui/brand-light.svg?v=brand-3" alt="FIT Requests" style="display:block;width:100%;max-width:380px;height:auto;margin:0 auto 8px"><p style="text-align:center;margin:0 auto 24px;color:#606874">Заявки на web-разработку</p>'+body+'</main></body></html>')}
export async function initBotAuth(pool){await pool.query("CREATE TABLE IF NOT EXISTS fit_auth_bot_challenges(challenge_hash text PRIMARY KEY,browser_hash text NOT NULL,claimant_id text,claimant_name text,status text NOT NULL DEFAULT 'pending',expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()); CREATE INDEX IF NOT EXISTS fit_bot_expires ON fit_auth_bot_challenges(expires_at)")}
export function makeBotLogin({pool,env=process.env,fetcher=fetch,logger=console}){
 const botUsername=String(env.TELEGRAM_BOT_USERNAME||"fit_requests_auth_bot").replace(/^@/,"");
 const botToken=env.TELEGRAM_BOT_TOKEN;
 const configured=()=>/^\d{5,16}:[A-Za-z0-9_-]{30,}$/.test(String(botToken||""))&&/^\d{4,20}$/.test(String(env.TELEGRAM_ADMIN_ID||""))&&/^[A-Za-z0-9_]{5,32}$/.test(botUsername);

 async function api(method,params={}){const response=await fetcher("https://api.telegram.org/bot"+botToken+"/"+method,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(params),signal:AbortSignal.timeout(20000)});if(!response.ok){let detail="";try{const failed=await response.json();detail=String(failed.description||"").slice(0,150)}catch{}throw Error("Telegram Bot API HTTP "+response.status+" on "+method+(detail?" ("+detail+")":""))}const data=await response.json();if(!data.ok)throw Error("Telegram Bot API rejected "+method+" code "+data.error_code);return data.result}
 async function allowed(id){if(!telegramId(id))return false;if(String(id)===String(env.TELEGRAM_ADMIN_ID))return true;const q=await pool.query("SELECT 1 FROM fit_auth_users WHERE telegram_id=$1 AND active=true LIMIT 1",[String(id)]);return q.rows.length>0}
 async function create(req,res){
  if(!configured())return page(res,"<h1>Авторизация не настроена</h1><p class=muted>Сервер ожидает токен бота и ID администратора.</p>");
  const challenge=key(),browser=key();await pool.query("DELETE FROM fit_auth_bot_challenges WHERE expires_at<now()");
  await pool.query("INSERT INTO fit_auth_bot_challenges(challenge_hash,browser_hash,expires_at) VALUES($1,$2,now()+interval '5 minutes')",[hash(challenge),hash(browser)]);
  const link="https://t.me/"+botUsername+"?start=login_"+challenge;
  // A single initial response provides browser-bound cookie and link without saving the raw token.
  res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Set-Cookie":cookie(flowCookie,browser,300),"Cache-Control":"no-store","Referrer-Policy":"no-referrer","Content-Security-Policy":"default-src 'none';img-src 'self';style-src 'unsafe-inline';base-uri 'none';frame-ancestors 'none'","X-Frame-Options":"DENY"});
  res.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta charset="utf-8"><title>FIT Requests — вход через Telegram</title><link rel="icon" type="image/svg+xml" href="/ui/favicon.svg?v=brand-3"><style>body{background:#f7f8fa;font:15px system-ui;margin:0;color:#222}.card{max-width:470px;background:#fff;margin:8vh auto;padding:28px;border-radius:14px;border:1px solid #e5e7eb}.button{display:inline-block;background:#fe5000;padding:12px 18px;border-radius:9px;color:white;text-decoration:none;font-weight:700}p{line-height:1.6;color:#66717d}a{color:#d94800}@media(max-width:520px){.card{margin:18px;padding:20px}}</style></head><body><main class="card"><img src="/ui/brand-light.svg?v=brand-3" alt="FIT Requests" style="display:block;width:100%;height:auto;margin:0 auto 8px"><p style="text-align:center;margin:0 auto 24px;color:#606874">Заявки на web-разработку</p><h1>Вход в сервис</h1><p>1. Открой бота и нажми Start.<br>2. Нажми «Подтвердить вход» в Telegram.<br>3. Вернись в эту вкладку и нажми «Продолжить».</p><p><a class="button" href="'+textEscape(link)+'" target="_blank" rel="noopener noreferrer">Открыть Telegram-бота</a></p><p><a href="/auth/bot/wait">Продолжить после подтверждения</a></p><p>Одноразовая ссылка действительна 5 минут. Не пересылай ее другим людям.</p></main></body></html>');
 }
 async function wait(req,res){
  const browser=cookies(req)[flowCookie];if(!browser||browser.length>200)return redirect(res,"/");
  const q=await pool.query("SELECT challenge_hash,claimant_id,claimant_name,status FROM fit_auth_bot_challenges WHERE browser_hash=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 1",[hash(browser)]);
  if(!q.rows.length)return page(res,'<h1>Время входа истекло</h1><a class="button" href="/auth/bot/start">Попробовать снова</a>');
  if(q.rows[0].status!=="approved"){const claimed=q.rows[0].status==="claimed";return page(res,'<h1>'+(claimed?"Подтверди вход в боте":"Ожидание сообщения от бота")+'</h1><p class="muted">'+(claimed?"Telegram уже открыл твой запрос. Нажми кнопку «Подтвердить вход» в чате с ботом.":"Открой бота по кнопке из предыдущего шага и нажми Start. Если ссылка потерялась, создай новый запрос.")+'</p><a href="/auth/bot/wait">Обновить</a> · <a href="/auth/bot/start">Новый запрос</a>',true)}
  const row=await pool.query("DELETE FROM fit_auth_bot_challenges WHERE challenge_hash=$1 AND browser_hash=$2 AND status='approved' AND expires_at>now() RETURNING claimant_id,claimant_name",[q.rows[0].challenge_hash,hash(browser)]);
  if(!row.rows.length)return redirect(res,"/");
  const id=String(row.rows[0].claimant_id);if(!await allowed(id))return page(res,"<h1>Доступ не разрешен</h1>");
  if(id===String(env.TELEGRAM_ADMIN_ID))await pool.query("INSERT INTO fit_auth_users(telegram_id,display_name,role,active) VALUES($1,$2,'admin',true) ON CONFLICT(telegram_id) DO UPDATE SET display_name=EXCLUDED.display_name,role='admin',active=true",[id,row.rows[0].claimant_name]);
  const session=key()+key();await pool.query("INSERT INTO fit_auth_sessions(token_hash,telegram_id,expires_at) VALUES($1,$2,now()+interval '7 days')",[hash(session),id]);
  redirect(res,"/app",{"Set-Cookie":[cookie(sessionCookie,session,604800),cookie(flowCookie,"",0)]});
 }
 async function handle(update){
  const msg=update.message;
  if(msg?.chat?.type==="private"&&typeof msg.text==="string"&&msg.text.startsWith("/start login_")){
   const challenge=msg.text.slice("/start login_".length).trim(),id=String(msg.from?.id||"");
   if(!/^[A-Za-z0-9_-]{43}$/.test(challenge)){logger.warn("Telegram login rejected: malformed deep link");await api("sendMessage",{chat_id:msg.chat.id,text:"Недействительная ссылка входа. Создай новую в FIT Requests."});return}
   if(!await allowed(id)){logger.warn("Telegram login rejected: account not in allowlist");await api("sendMessage",{chat_id:msg.chat.id,text:"Доступ к FIT Requests не разрешен: Telegram ID этого аккаунта не совпадает с ID администратора. Проверь TELEGRAM_ADMIN_ID в Railway."});return}
   const name=[msg.from?.first_name,msg.from?.last_name].filter(Boolean).join(" ").slice(0,120);
   const q=await pool.query("UPDATE fit_auth_bot_challenges SET claimant_id=$2,claimant_name=$3,status='claimed' WHERE challenge_hash=$1 AND expires_at>now() AND status IN ('pending','claimed') AND (claimant_id IS NULL OR claimant_id=$2) RETURNING challenge_hash",[hash(challenge),id,name]);
   if(!q.rows.length){logger.warn("Telegram login rejected: challenge expired or already used");await api("sendMessage",{chat_id:msg.chat.id,text:"Запрос уже использован или истек. Создай новый на сайте."});return}
   logger.info("Telegram login challenge claimed; confirmation requested");
   await api("sendMessage",{chat_id:msg.chat.id,text:"FIT Requests: подтвердить вход в браузере? Если ты не пыталась войти, ничего не нажимай.",reply_markup:{inline_keyboard:[[{text:"Подтвердить вход",callback_data:"fit:"+challenge}]]}});
   return;
  }
  const c=update.callback_query;
  if(c&&String(c.data||"").startsWith("fit:")){
   const challenge=String(c.data).slice(4),id=String(c.from?.id||"");
   let approved=false;
   if(/^[A-Za-z0-9_-]{43}$/.test(challenge)&&await allowed(id)){
    const q=await pool.query("UPDATE fit_auth_bot_challenges SET status='approved' WHERE challenge_hash=$1 AND claimant_id=$2 AND status='claimed' AND expires_at>now() RETURNING challenge_hash",[hash(challenge),id]);
    approved=q.rows.length>0;
   }
   logger.info("Telegram login confirmation received",{approved});
   await api("answerCallbackQuery",{callback_query_id:c.id,text:approved?"Вход подтвержден. Вернись в браузер.":"Запрос истек или недействителен.",show_alert:!approved});
   if(approved&&c.message?.chat?.id)await api("sendMessage",{chat_id:c.message.chat.id,text:"Вход в FIT Requests подтвержден. Вернись в браузер и нажми «Продолжить»."});
  }
 }
 async function configureWebhook(){
  if(!configured())return logger.warn("Telegram webhook disabled: missing bot credentials");
  const origin=String(env.PUBLIC_ORIGIN||"");
  const secret=String(env.TELEGRAM_WEBHOOK_SECRET||"");
  if(!/^https:\/\/[^/]+$/.test(origin)||!/^[A-Za-z0-9_-]{32,256}$/.test(secret))return logger.warn("Telegram webhook disabled: missing HTTPS origin or secret");
  const info=await api("getMe");
  if(info?.username!==botUsername)throw Error("Telegram Bot API token belongs to unexpected bot");
  logger.info("Telegram bot authenticated",{bot:"expected",botIdPresent:Boolean(info?.id)});
  const url=origin+"/webhooks/telegram";
  await api("setWebhook",{url,secret_token:secret,allowed_updates:["message","callback_query"],max_connections:2,drop_pending_updates:false});
  logger.info("Telegram webhook configured");
 }
 const webhookSecret=String(env.TELEGRAM_WEBHOOK_SECRET||"");
 const acceptWebhook=(given)=>webhookSecret.length>=32&&given.length===webhookSecret.length&&timingSafeEqual(Buffer.from(given),Buffer.from(webhookSecret));
 return {create,wait,configureWebhook,acceptWebhook,configured,handle};
}
