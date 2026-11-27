import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {once} from "node:events";
import {createServer} from "node:net";
import {setTimeout as delay} from "node:timers/promises";
import {makeDb} from "../src/db.js";
import {requestFields} from "../public/ui/request-fields.js";

const databaseUrl=process.env.REQUEST_ACCESS_TEST_DATABASE_URL;

async function localOrigin(){
 const socket=createServer().listen(0,"127.0.0.1");
 await once(socket,"listening");
 const origin="http://127.0.0.1:"+socket.address().port;
 await new Promise(resolve=>socket.close(resolve));
 return origin;
}

test("request and Kaiten HTTP responses respect the caller's role and ownership",
 {skip:!databaseUrl,timeout:20000},async()=>{
 const db=makeDb(databaseUrl);
 const schema="request_access_test_"+process.pid;
 const scopedUrl=new URL(databaseUrl);
 scopedUrl.searchParams.set("options","-c search_path="+schema);
 const scoped=makeDb(scopedUrl.href);
 let server,serverLog="";
 try{
  await db.query("CREATE SCHEMA "+schema);
  const origin=await localOrigin();
  const adminToken="local-test-admin-"+randomUUID();
  // Stub only outgoing Kaiten requests. HTTP routes, sessions and PostgreSQL are real.
  const kaitenFixture=`
   globalThis.fetch=async input=>{
    if(!String(input).startsWith("https://fixture.kaiten.ru/"))throw new Error("Unexpected upstream request");
    return Response.json(String(input).includes("/children")
     ? [{id:902,title:"Internal child",size_text:"8h",owner_id:777,members:[{id:888}]}] : []);
   };
  `;
  server=spawn(process.execPath,["--import","data:text/javascript,"+encodeURIComponent(kaitenFixture),"src/server.js"],{
   cwd:new URL("../",import.meta.url),
   env:{
    PATH:process.env.PATH, DATABASE_URL:scopedUrl.href,PORT:new URL(origin).port,PUBLIC_ORIGIN:origin,
    KAITEN_BASE_URL:"https://fixture.kaiten.ru",KAITEN_SPACE_ID:"123",KAITEN_API_TOKEN:"local-test-kaiten",
    ADMIN_API_TOKEN:adminToken,KAITEN_WEBHOOK_SECRET:"local-test-webhook-"+randomUUID()
   },
   stdio:["ignore","pipe","pipe"]
  });
  for(const stream of [server.stdout,server.stderr])stream.on("data",chunk=>{serverLog+=chunk});
  const caller={one:"111",two:"222",admin:"333"};
  async function request(path,{as,method="GET",body,bearer,requestOrigin=origin}={}){
   return fetch(origin+path,{method,redirect:"manual",headers:{
    ...(as?{Cookie:"__Host-fit_session="+caller[as]}:{}),
    ...(bearer?{Authorization:"Bearer "+adminToken}:{}),
    ...(body?{Origin:requestOrigin,"Content-Type":"application/json"}:{})
   },body:body&&JSON.stringify(body),signal:AbortSignal.timeout(3000)});
  }
  let ready=false;
  for(let attempt=0;attempt<100&&server.exitCode===null;attempt++){
   try{ready=(await request("/healthz")).ok}catch{}
   if(ready)break;
   await delay(50);
  }
  assert.ok(ready,serverLog);

  for(const [name,id] of Object.entries(caller)){
   await scoped.query("INSERT INTO fit_auth_users(telegram_id,display_name,role) VALUES ($1,$2,$3)",[id,name,name==="admin"?"admin":"employee"]);
   const hash=createHash("sha256").update(id).digest("hex");
   await scoped.query("INSERT INTO fit_auth_sessions(token_hash,telegram_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')",[hash,id]);
  }

  const path="/api/requests";
  const privateFields={
   kaiten:"https://fixture.kaiten.ru/card/901",priority:"internal",assignee:"developer",
   estimate:{raw:8},comments:["internal comment"],members:[888],childCards:[902],
   locationHistory:[{column:27}],blocked:true,syncError:"internal failure",_mutation:{operationId:"hidden"}
  };
  const customerFields={title:"Своя заявка",owner:"Ответственный",description:"Описание",requestKind:"other",
   actualUrl:"https://example.org/page",materials:"https://example.org/files",express:"https://example.org/chat",
   goal:"Результат",desiredDue:"2026-12-01",pageAction:"new",pageOwner:"Исторический ответственный"};
  const allowed=new Set([...requestFields.map(([key])=>key),"project","requester","department","pageAction","pageOwner",
   "requestKind","id","revision","createdBy","created","updatedAt","status"]);
  function expectPublic(item,expected){
   assert.deepEqual(Object.keys(item).filter(key=>!allowed.has(key)),[]);
   for(const [key,value] of Object.entries(expected))assert.equal(item[key],value,key);
  }
  async function item(response,status){
   assert.equal(response.status,status);
   return (await response.json()).item;
  }
  const denied=[
   "/api/requests/REQ-1000/kaiten/children","/api/requests/REQ-9000/kaiten/children",
   "/api/cards","/api/sync/status","/api/kaiten/pm-destination","/api/kaiten/boards",
   "/api/kaiten/boards/1","/api/kaiten/search?q=secret","/api/analytics","/api/analytics.xlsx"
  ];
  assert.equal((await request(path)).status,401);
  for(const endpoint of denied)assert.equal((await request(endpoint)).status,401,endpoint);

  const operationId=randomUUID();
  const draftBody={requestKind:"other",title:customerFields.title,status:"Черновик",operationId};
  const draft=await item(await request(path,{as:"one",method:"POST",body:draftBody}),201);
  expectPublic(draft,{status:"Черновик",title:customerFields.title});
  const other=await item(await request(path,{as:"two",method:"POST",body:{...customerFields,title:"Вторая заявка"}}),201);
  const scope=path+"/"+draft.id;
  const updateBody={...customerFields,status:"Новая",revision:draft.revision,operationId:randomUUID()};
  const submitted=await item(await request(scope,{as:"one",method:"PUT",body:updateBody}),200);
  expectPublic(submitted,{...customerFields,id:draft.id,status:"Новая",requester:"one"});

  await scoped.query(`INSERT INTO kaiten_cards(id, space_id, title, estimate_text, owner_id, member_ids, data)
   VALUES (901,123,'Internal parent','8h',777,'[888]','{}')`);
  await scoped.query("UPDATE fit_requests SET kaiten_card_id=901,payload=payload||$2::jsonb WHERE id=$1",[draft.id,JSON.stringify(privateFields)]);

  const expected={...customerFields,id:draft.id,status:"Передана в Kaiten"};
  const list=await (await request(path,{as:"one"})).json();
  assert.equal(list.items.length,1);
  expectPublic(list.items[0],expected);
  expectPublic(await item(await request(path,{as:"one",method:"POST",body:draftBody}),201),expected);
  expectPublic(await item(await request(scope,{as:"one",method:"PUT",body:updateBody}),200),expected);
  expectPublic(await item(await request(scope,{as:"one",method:"PUT",body:{...updateBody,operationId:randomUUID(),revision:submitted.revision}}),200),expected);
  assert.deepEqual((await (await request(path,{as:"two"})).json()).items.map(row=>row.id),[other.id]);

  for(const [as,foreignId] of [["one",other.id],["two",draft.id]]){
   for(const endpoint of denied)assert.equal((await request(endpoint,{as})).status,403,endpoint);
   for(const method of ["PUT","DELETE"]){
    for(const id of [foreignId,"REQ-9000"]){
     const response=await request(path+"/"+id,{as,method,body:{revision:1}});
     assert.equal(response.status,404);
     assert.deepEqual(await response.json(),{error:"Заявка не найдена"});
    }
   }
   assert.equal((await request(path+"/"+foreignId,{as})).status,404);
   assert.equal((await request(path+"/"+foreignId+"/kaiten",{as,method:"POST",body:{action:"link",cardId:"901"}})).status,403);
   assert.equal((await request(path+"/"+foreignId+"/kaiten/create",{as,method:"POST",body:{laneId:"1"}})).status,403);
   assert.equal((await request("/app/kaiten",{as})).status,403);
   assert.equal((await request("/app/analytics",{as})).status,403);
   assert.equal((await request("/exports/development.csv",{as})).status,403);
  }
  const admin=await (await request(path,{as:"admin"})).json();
  assert.equal(admin.items.length,2);
  assert.equal(admin.items.find(row=>row.id===draft.id).kaitenParent.estimateText,"8h");
  const children=await request(scope+"/kaiten/children",{as:"admin"});
  assert.equal(children.status,200);
  assert.equal((await children.json()).items[0].estimateText,"8h");
  assert.equal((await request("/api/cards",{as:"admin"})).status,200);
  assert.equal((await request("/api/sync/status",{as:"admin"})).status,200);
  assert.equal((await request("/api/sync/status",{bearer:true})).status,200);
  for(const page of ["/app","/app/registry"]){
   const response=await request(page,{as:"one"});
   assert.equal(response.status,200);
   assert.equal(response.headers.get("referrer-policy"),"same-origin");
   assert.match(await response.text(),/<form action="\/auth\/logout" method="post"/);
  }
  for(const requestOrigin of ["null","https://other.example"]){
   assert.equal((await request("/auth/logout",{as:"one",method:"POST",body:{},requestOrigin})).status,403);
   assert.equal((await request("/api/me",{as:"one"})).status,200);
  }
  const logout=await request("/auth/logout",{as:"one",method:"POST",body:{}});
  assert.equal(logout.status,303);
  assert.equal(logout.headers.get("location"),"/");
  assert.equal((await request("/api/me",{as:"one"})).status,401);

 }finally{
  if(server&&server.exitCode===null&&server.signalCode===null){
   const exited=once(server,"exit");
   server.kill();
   await exited;
  }
  await scoped.end();
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE");
  await db.end();
 }
});
