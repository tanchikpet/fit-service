import {randomBytes,createHash,timingSafeEqual} from "node:crypto";
import {jwtVerify,createRemoteJWKSet} from "jose";
const jwks=createRemoteJWKSet(new URL("https://oauth.telegram.org/.well-known/jwks.json"));
const token=()=>randomBytes(32).toString("base64url");
const digest=s=>createHash("sha256").update(s).digest("hex");
const equals=(a,b)=>{const x=Buffer.from(String(a||"")),y=Buffer.from(String(b||""));return x.length===y.length&&timingSafeEqual(x,y)};
const cookies=req=>Object.fromEntries(String(req.headers.cookie||"").split(";").map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf("=");return [x.slice(0,i),x.slice(i+1)]}));
const sessionCookie="__Host-fit_session",flowCookie="__Host-fit_flow";
const cookie=(name,value,age)=>name+"="+value+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age="+age;
const redirect=(res,location,headers={})=>{res.writeHead(303,{Location:location,"Cache-Control":"no-store",...headers});res.end()};
const reply=(res,status,text)=>{res.writeHead(status,{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store","X-Frame-Options":"DENY"});res.end(text)};
export async function initAuth(pool){await pool.query(`
CREATE TABLE IF NOT EXISTS fit_auth_users(telegram_id text PRIMARY KEY,display_name text,role text NOT NULL CHECK(role IN ('admin','employee')),active boolean NOT NULL DEFAULT true,invited_by text,created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS fit_auth_flows(state_hash text PRIMARY KEY,verifier text NOT NULL,cookie_hash text NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS fit_auth_sessions(token_hash text PRIMARY KEY,telegram_id text NOT NULL REFERENCES fit_auth_users(telegram_id),expires_at timestamptz NOT NULL,revoked_at timestamptz);
`)}
export function telegramAuth({pool,env=process.env,fetcher=fetch}){
 const origin=env.PUBLIC_ORIGIN||"";
 const configured=()=>/^https:\/\/[^/]+$/.test(origin)&&/^\d{5,20}$/.test(String(env.TELEGRAM_CLIENT_ID||""))&&Boolean(env.TELEGRAM_CLIENT_SECRET)&&/^\d{4,20}$/.test(String(env.TELEGRAM_ADMIN_ID||""));
 const isId=s=>/^\d{4,20}$/.test(String(s||""));
 async function user(req){const raw=cookies(req)[sessionCookie];if(!raw||raw.length>200)return null;
 const q=await pool.query("SELECT u.telegram_id,u.display_name,u.role FROM fit_auth_sessions s JOIN fit_auth_users u ON u.telegram_id=s.telegram_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL AND u.active=true LIMIT 1",[digest(raw)]);return q.rows[0]||null}
 async function start(req,res){if(!configured())return reply(res,503,"Telegram Login not configured");
 const state=token(),verifier=token(),flow=token();await pool.query("DELETE FROM fit_auth_flows WHERE expires_at<now()");
 await pool.query("INSERT INTO fit_auth_flows(state_hash,verifier,cookie_hash,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')",[digest(state),verifier,digest(flow)]);
 const url=new URL("https://oauth.telegram.org/auth");for(const [k,v] of Object.entries({client_id:env.TELEGRAM_CLIENT_ID,redirect_uri:origin+"/auth/callback",response_type:"code",scope:"openid profile",state,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"}))url.searchParams.set(k,v);
 redirect(res,url.href,{"Set-Cookie":cookie(flowCookie,flow,300)})}
 async function callback(req,res,url){if(!configured())return reply(res,503,"Telegram Login not configured");
 const state=url.searchParams.get("state"),code=url.searchParams.get("code"),flow=cookies(req)[flowCookie];
 if(!state||state.length>256||!code||code.length>4096||!flow)return reply(res,400,"Invalid login flow");
 const q=await pool.query("DELETE FROM fit_auth_flows WHERE state_hash=$1 AND expires_at>now() RETURNING verifier,cookie_hash",[digest(state)]);
 if(!q.rows.length||!equals(q.rows[0].cookie_hash,digest(flow)))return reply(res,403,"Expired login flow");
 let subject,name;try{
 const response=await fetcher("https://oauth.telegram.org/token",{method:"POST",headers:{Authorization:"Basic "+Buffer.from(env.TELEGRAM_CLIENT_ID+":"+env.TELEGRAM_CLIENT_SECRET).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:origin+"/auth/callback",client_id:env.TELEGRAM_CLIENT_ID,code_verifier:q.rows[0].verifier}),signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error("Telegram token rejected");const body=await response.json();
 const verified=await jwtVerify(body.id_token,jwks,{issuer:"https://oauth.telegram.org",audience:String(env.TELEGRAM_CLIENT_ID),algorithms:["RS256"],clockTolerance:30});
 subject=String(verified.payload.sub||"");name=String(verified.payload.name||verified.payload.preferred_username||"Telegram").slice(0,120);
 if(!isId(subject)||!verified.payload.iat||Math.abs(Date.now()/1000-verified.payload.iat)>300)throw Error("Invalid claims");
 }catch{return reply(res,401,"Telegram identity verification failed")}
 if(subject===String(env.TELEGRAM_ADMIN_ID)){await pool.query("INSERT INTO fit_auth_users(telegram_id,display_name,role,active) VALUES($1,$2,'admin',true) ON CONFLICT(telegram_id) DO UPDATE SET display_name=EXCLUDED.display_name,role='admin',active=true",[subject,name])}
 const authorized=await pool.query("SELECT telegram_id FROM fit_auth_users WHERE telegram_id=$1 AND active=true",[subject]);if(!authorized.rows.length)return reply(res,403,"Account is not invited");
 const session=token()+token();await pool.query("INSERT INTO fit_auth_sessions(token_hash,telegram_id,expires_at) VALUES($1,$2,now()+interval '7 days')",[digest(session),subject]);
 redirect(res,"/app",{"Set-Cookie":[cookie(sessionCookie,session,604800),cookie(flowCookie,"",0)]})}
 async function logout(req,res){const raw=cookies(req)[sessionCookie];if(raw)await pool.query("UPDATE fit_auth_sessions SET revoked_at=now() WHERE token_hash=$1",[digest(raw)]);redirect(res,"/",{"Set-Cookie":cookie(sessionCookie,"",0)})}
 async function invite(req,res,id){const me=await user(req);if(!me||me.role!=="admin")return reply(res,403,"Forbidden");if(!isId(id)||id===String(env.TELEGRAM_ADMIN_ID))return reply(res,400,"Invalid Telegram ID");
 await pool.query("INSERT INTO fit_auth_users(telegram_id,role,active,invited_by) VALUES($1,'employee',true,$2) ON CONFLICT(telegram_id) DO UPDATE SET active=true",[id,me.telegram_id]);redirect(res,"/app")}
 return {user,start,callback,logout,invite,configured};
}
