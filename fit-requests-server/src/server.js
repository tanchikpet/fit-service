import http from "node:http";
import {timingSafeEqual} from "node:crypto";
import {loadConfig} from "./config.js";
import {makeDb,setupDb} from "./db.js";
import {makeSync} from "./sync.js";
const config=loadConfig();const pool=makeDb(config.databaseUrl);
await setupDb(pool);
const sync=makeSync({pool,config});
const safeEqual=(a,b)=>{const x=Buffer.from(String(a||"")),y=Buffer.from(String(b||""));return x.length===y.length&&timingSafeEqual(x,y)};
function send(res,status,value){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"});res.end(JSON.stringify(value))}
function authorized(req){return safeEqual(req.headers.authorization,"Bearer "+config.adminToken)}
function collect(req,max=65536){return new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on("data",b=>{size+=b.length;if(size>max){reject(Error("body-too-large"));req.destroy()}else chunks.push(b)});req.on("end",()=>resolve(Buffer.concat(chunks).toString("utf8")));req.on("error",reject)})}
const server=http.createServer(async(req,res)=>{
 const path=new URL(req.url||"/","http://localhost").pathname;
 try{
  if(path==="/healthz"&&req.method==="GET"){send(res,200,{ok:true});return}
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
  if(!authorized(req)){send(res,401,{error:"unauthorized"});return}
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
});
const timer=setInterval(()=>sync.run("scheduled").catch(()=>{}),config.intervalMs);
async function shutdown(){clearInterval(timer);server.close();await pool.end();process.exit(0)}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
