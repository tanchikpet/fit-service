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
 // PostgreSQL advisory locks are shared across schemas.
 const schema="request_access_test_"+process.pid;
 const scopedUrl=new URL(databaseUrl);
 scopedUrl.pathname="/"+schema;
 const scoped=makeDb(scopedUrl.href);
 let server,serverLog="";
 try{
  await db.query("CREATE DATABASE "+schema);
  const origin=await localOrigin();
  const adminToken="local-test-admin-"+randomUUID();
  // Stub only outgoing Kaiten requests. HTTP routes, sessions and PostgreSQL are real.
  const kaitenFixture=`
   globalThis.fetch=async (input,options={})=>{
    const url=new URL(input);
    if(url.origin!=="https://fixture.kaiten.ru")throw new Error("Unexpected upstream request");
    if(url.pathname.endsWith("/boards"))return Response.json([{id:20,title:"PM"}]);
    if(url.pathname.endsWith("/boards/20"))return Response.json({id:20,columns:[{id:30,title:"Анализ"}],lanes:[{id:40,title:"Входящие"}]});
    if(url.pathname.endsWith("/cards")&&options.method==="POST"){
     const body=JSON.parse(options.body);
     return Response.json({id:903,title:body.title,description:body.description,external_id:body.external_id,board_id:20,column_id:30,lane_id:40});
    }
    return Response.json(url.pathname.endsWith("/children")
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
  async function request(path,{as,method="GET",body,bearer,requestOrigin=origin,form=false}={}){
   return fetch(origin+path,{method,redirect:"manual",headers:{
    ...(as?{Cookie:"__Host-fit_session="+caller[as]}:{}),
    ...(bearer?{Authorization:"Bearer "+adminToken}:{}),
    ...(body?{Origin:requestOrigin,"Content-Type":form?"application/x-www-form-urlencoded":"application/json"}:{})
   },body:body&&(form?new URLSearchParams(body):JSON.stringify(body)),signal:AbortSignal.timeout(3000)});
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
   "requestKind","formVersion","formAnswers","id","revision","createdBy","created","updatedAt","status"]);
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

  assert.equal((await request("/api/form-types")).status,401);
  assert.equal((await request("/api/admin/form-types",{as:"one"})).status,403);
  assert.equal((await request("/api/admin/form-types",{as:"two",method:"POST",body:{action:"create",name:"Скрытый"}})).status,403);
  assert.equal((await request("/app/form-types",{as:"one"})).status,403);
  assert.equal((await request("/app/form-types",{as:"admin"})).status,200);
  const enrichment="/app/analytics/enrichment";
  const enrichmentBody={kind:"dictionaries",action:"start",free:"200"};
  assert.equal((await request(enrichment,{method:"POST",body:enrichmentBody,form:true})).status,401);
  assert.equal((await request(enrichment,{as:"one",method:"POST",body:enrichmentBody,form:true})).status,403);
  assert.equal((await request(enrichment,{as:"admin",method:"POST",body:enrichmentBody,form:true,requestOrigin:"https://cross-origin.invalid"})).status,403);
  assert.equal((await request(enrichment,{as:"admin",method:"POST",body:enrichmentBody,form:true})).status,409);
  const migration="/app/analytics/enrichment-migration";
  const prepare={action:"prepare"};
  assert.equal((await request(migration,{method:"POST",body:prepare,form:true})).status,401);
  assert.equal((await request(migration,{as:"one",method:"POST",body:prepare,form:true})).status,403);
  assert.equal((await request(migration,{as:"admin",method:"POST",body:prepare,form:true,requestOrigin:"https://cross-origin.invalid"})).status,403);
  assert.equal((await request(migration,{as:"admin"})).status,405);
  assert.equal((await request(migration,{as:"admin",method:"POST",body:{action:"apply",confirmed:"yes"},form:true})).status,403);
  const readyMigration=await request(migration,{as:"admin",method:"POST",body:prepare,form:true});
  assert.equal(readyMigration.status,200);
  const migrationToken=(await readyMigration.text()).match(/name="token" value="([^"]+)"/)?.[1];
  assert.ok(migrationToken);
  assert.equal((await scoped.query("SELECT to_regclass('kaiten_enrichment_workflow') AS present")).rows[0].present,null);
  const applyMigration={action:"apply",token:migrationToken};
  assert.equal((await request(migration,{as:"admin",method:"POST",body:applyMigration,form:true})).status,403);
  const appliedMigration=await request(migration,{as:"admin",method:"POST",body:{...applyMigration,confirmed:"yes"},form:true});
  assert.equal(appliedMigration.status,200);
  assert.match(await appliedMigration.text(),/Миграция 002 применена/);
  assert.equal((await request(migration,{as:"admin",method:"POST",body:{...applyMigration,confirmed:"yes"},form:true})).status,403);
  assert.equal((await scoped.query("SELECT count(*)::int AS n FROM kaiten_enrichment_workflow")).rows[0].n,0);
  const activity="/app/analytics/targeted-activity";
  assert.equal((await request(activity,{method:"POST",body:{},form:true})).status,401);
  assert.equal((await request(activity,{as:"one",method:"POST",body:{},form:true})).status,403);
  assert.equal((await request(activity,{as:"admin",method:"POST",body:{},form:true,requestOrigin:"https://cross-origin.invalid"})).status,403);
  assert.equal((await request(activity,{as:"admin"})).status,405);
  const diagnostic="/app/analytics/diagnostics";
  const diagnosticExcel="/api/analytics/diagnostics.xlsx";
  assert.equal((await request(diagnostic,{method:"POST",body:{},form:true})).status,401);
  assert.equal((await request(diagnostic,{as:"one",method:"POST",body:{},form:true})).status,403);
  assert.equal((await request(diagnostic,{as:"admin",method:"POST",body:{},form:true,requestOrigin:"https://cross-origin.invalid"})).status,403);
  assert.equal((await request(diagnostic,{as:"admin"})).status,405);
  assert.equal((await request(diagnosticExcel,{as:"one"})).status,403);
  assert.equal((await request(diagnosticExcel,{as:"admin"})).status,404);
  assert.match(await (await request("/app/analytics",{as:"admin"})).text(),/Диагностика данных Kaiten/);
  assert.equal((await request(diagnostic,{as:"admin",method:"POST",body:{},form:true})).status,303);
  assert.equal((await request(diagnostic,{as:"admin",method:"POST",body:{},form:true})).status,409);
  const catalog=await (await request("/api/form-types",{as:"one"})).json();
  assert.deepEqual(catalog.items.map(row=>row.typeId),["new","update","other"]);
  const operationId=randomUUID();
  const draftBody={requestKind:"other",title:customerFields.title,status:"Черновик",operationId};
  const draft=await item(await request(path,{as:"one",method:"POST",body:draftBody}),201);
  expectPublic(draft,{status:"Черновик",title:customerFields.title});
  const other=await item(await request(path,{as:"two",method:"POST",body:{...customerFields,title:"Вторая заявка"}}),201);
  const scope=path+"/"+draft.id;
  const adminDraft=await item(await request(path,{as:"admin",method:"POST",body:draftBody}),201);
  const adminBeforeSubmit=await (await request(path,{as:"admin"})).json();
  assert.deepEqual(adminBeforeSubmit.items.map(row=>row.id).sort(),[other.id,adminDraft.id].sort());
  assert.equal((await request(scope,{as:"admin",method:"PUT",body:{revision:draft.revision,status:"Новая"}})).status,404);
  assert.equal((await request(scope,{as:"admin",method:"DELETE",body:{revision:draft.revision}})).status,404);
  assert.equal((await request(scope+"/kaiten",{as:"admin",method:"POST",body:{action:"link",cardId:"901"}})).status,404);
  assert.equal((await request(scope+"/kaiten/create",{as:"admin",method:"POST",body:{laneId:"1"}})).status,404);
  assert.equal((await request(path+"/"+adminDraft.id,{as:"admin",method:"DELETE",body:{revision:adminDraft.revision}})).status,200);
  const updateBody={...customerFields,status:"Новая",revision:draft.revision,operationId:randomUUID()};
  const submitted=await item(await request(scope,{as:"one",method:"PUT",body:updateBody}),200);
  expectPublic(submitted,{...customerFields,id:draft.id,status:"Новая",requester:"one"});
  assert.equal(submitted.formVersion.id,draft.formVersion.id);
  assert.equal(submitted.formAnswers.owner,customerFields.owner);

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
  for(const page of ["/app","/app/registry"]){
   const anonymous=await request(page);
   assert.equal(anonymous.status,303);
   for(const as of ["one","two","admin"]){
    const response=await request(page,{as});
    assert.equal(response.status,200);
    assert.equal((await response.text()).includes('href="/app/kaiten"'),as==="admin");
   }
  }
  const dashboard=await request("/app/kaiten",{as:"admin"});
  assert.equal(dashboard.status,200);
  assert.match(await dashboard.text(),/Доступ сотрудников/);
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
  async function configure(body){
   const response=await request("/api/admin/form-types",{as:"admin",method:"POST",body});
   assert.equal(response.status,200);
   return (await response.json()).items.find(row=>row.id===body.id||row.draft.name==="Тестовый тип");
  }
  let configured=await configure({action:"create",name:"Тестовый тип"});
  const formSchema=structuredClone(configured.draft);
  formSchema.sections[0].fields[0].label="Название интеграции";
  formSchema.sections[0].fields.push({id:"field-enabled",type:"boolean",label:"Включить",required:true,defaultValue:false});
  configured=await configure({action:"publish",id:configured.id,revision:configured.revision,schema:formSchema,position:10});
  const beforeActivation=await (await request("/api/form-types",{as:"one"})).json();
  assert.ok(!beforeActivation.items.some(version=>version.typeId===configured.id));
  configured=await configure({action:"state",id:configured.id,revision:configured.revision,state:"active"});
  const dynamic=await item(await request(path,{as:"one",method:"POST",body:{
   requestKind:configured.id,formVersionId:configured.current_version_id,
   formAnswers:{title:"Проверка API","field-enabled":false}
  }}),201);
  expectPublic(dynamic,{title:"Проверка API",requestKind:configured.id});
  assert.equal(dynamic.formAnswers["field-enabled"],false);
  assert.equal(dynamic.formVersion.schema.sections[0].fields[0].label,"Название интеграции");
  assert.equal((await scoped.query("SELECT count(*)::int AS count FROM fit_kaiten_creation_attempts WHERE request_id=$1",[dynamic.id])).rows[0].count,0);
  const renamed=structuredClone(formSchema);
  renamed.sections[0].fields[1].label="Новая подпись";
  await configure({action:"publish",id:configured.id,revision:configured.revision,schema:renamed,position:10});
  const sent=await request(path+"/"+dynamic.id+"/kaiten/create",{as:"admin",method:"POST",body:{laneId:"40"}});
  assert.equal(sent.status,201);
  assert.equal((await sent.json()).cardId,"903");
  const sentCard=(await scoped.query("SELECT data FROM kaiten_cards WHERE id=903")).rows[0].data;
  assert.equal(sentCard.title,"Проверка API");
  assert.match(sentCard.description,/Включить:\nНет/);
  assert.doesNotMatch(sentCard.description,/Новая подпись/);
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
  await db.query("DROP DATABASE IF EXISTS "+schema);
  await db.end();
 }
});
