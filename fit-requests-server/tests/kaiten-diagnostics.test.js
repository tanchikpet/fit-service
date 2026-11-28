import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import {makeDb,setupDb} from "../src/db.js";
import {diagnosticSnapshot,makeDiagnostics,runDiagnostics} from "../src/kaiten-diagnostics.js";
import {diagnosticsPanel,diagnosticsWorkbook} from "../src/kaiten-diagnostics-view.js";

const config={spaceId:15,kaitenBase:"https://example.kaiten.ru",kaitenToken:"secret-fixture"};
const now=new Date("2026-11-28T00:00:00Z");
const pause=async()=>{};
const summary={cards:1,events:0,histories:0};
const fixture={summary,fields:[],units:[],samples:[{id:"12345",board_id:"12",column_id:"10"}],columns:[
 {board:"12",column:"10",first:now,last:now,events:1}]};

function fakePool(snapshot=fixture){
 let connection;
 return {connect:async()=>{
  connection = {
   release(){},
   query:async sql=>{
    if (/^BEGIN|^SET|^COMMIT|^ROLLBACK/.test(sql))return {};
    if (/WITH source/.test(sql))return {rows:[...snapshot.fields]};
    if (/AS unit/.test(sql))return {rows:snapshot.units};
    if (/WITH cards/.test(sql))return {rows:snapshot.samples};
    if (/min\(changed_at/.test(sql))return {rows:snapshot.columns};
    return {rows:[snapshot.summary]};
   }
  };
  return connection;
 }};
}
test("diagnostics uses only bounded GETs and reports metadata without private values",async()=>{
 const requests=[];
 const fetcher=async(url,options)=>{
  requests.push(url);
  assert.equal(options.method,"GET");
  assert.equal(options.redirect,"error");
  if (url.pathname.endsWith("/12345"))return Response.json({
   title:"PRIVATE TITLE",description:"PRIVATE DESCRIPTION",owner_id:9876543,properties:{id_7:4},
   checklists:[{id:1}],uid:"01010101-0101-0101-0101-010101010101"
  });
  if(url.pathname.endsWith("/blockers"))return new Response(null,{status:403});
  if(url.pathname.endsWith("/baselines"))return new Response(null,{status:404});
  if(url.pathname.endsWith("/external-links"))return new Response(null,{status:405});
  if(url.pathname.endsWith("/location-history"))return Response.json([{changed:now.toISOString(),author_id:9876543,condition:1}]);
  if(url.pathname.endsWith("/columns"))return Response.json([{id:10,title:"PRIVATE COLUMN",type:2}]);
  if(url.pathname.endsWith("/activity")){
   const a=url.searchParams.get("created_after");
   const b=url.searchParams.get("created_before");
   const item={created:"2025-06-02T12:00:00Z",action:"card_update",
    data:{field:"due_date",old_value:"2025-05-01",new_value:null,description:"PRIVATE ACTIVITY"}};
   return Response.json({items:(!a||item.created>=a)&&item.created<=b?[item]:[],next_cursor:null});
  }
  return Response.json([]);
 };
 const report=await runDiagnostics({pool:fakePool(),config,now,fetcher,pause});
 assert.ok(requests.length>20&&requests.length<=70);
 assert.equal(report.probes.find(x=>x.name==="Блокировки").result,"нет прав");
 assert.match(report.probes.find(x=>x.name==="Базовые планы").result,/не найдено/);
 assert.equal(report.probes.find(x=>x.name==="Внешние связи").result,"метод не поддержан");
 assert.match(report.probes.find(x=>x.name==="Детальная карточка").fields.join(),/planned_start: ключ отсутствует/);
 assert.equal(report.activity.find(x=>x.category==="Сроки").beforeAfter,1);
 assert.equal(report.earliest.observed,"2025-06-02T12:00:00.000Z");
 assert.equal(report.columns[0].currentName,null);
 assert.equal(report.columns[0].processStage,null);
 assert.doesNotMatch(JSON.stringify(report),/PRIVATE|9876543|12345|secret-fixture/);
 const book=new ExcelJS.Workbook();
 await book.xlsx.load(await diagnosticsWorkbook(report));
 assert.equal(book.worksheets.length,8);
 assert.equal(book.getWorksheet("Сводка").getCell("B3").value,1);
 assert.match(diagnosticsPanel({report,running:false},String),/Скачать диагностику Excel/);
});

test("429 stops further API calls and concurrent diagnostics are refused",async()=>{
 let unblock;
 const barrier=new Promise(resolve=>{unblock=resolve;});
 let requests=0;
 const job=makeDiagnostics({pool:fakePool(),config,now,pause,fetcher:async()=>{
  requests++;
  await barrier;
  return new Response(null,{status:429});
 }});
 assert.equal(job.start(),true);
 assert.equal(job.start(),false);
 unblock();
 for(let i=0; i<40&&job.status().running; i++) await new Promise(resolve=>setImmediate(resolve));
 assert.equal(job.status().running,false);
 assert.equal(requests,1);
 assert.equal(job.status().report.probes[0].status,429);
 assert.match(job.status().report.probes.at(-1).result,/остановлено/);
});

test("aggregates all WEB cards with a read-only PostgreSQL transaction",
 {skip:!process.env.ANALYTICS_TEST_DATABASE_URL},async()=>{
 const db=makeDb(process.env.ANALYTICS_TEST_DATABASE_URL);
 const schema="diagnostics_test_"+process.pid;
 const isolated=new URL(process.env.ANALYTICS_TEST_DATABASE_URL);
 isolated.searchParams.set("options","-c search_path="+schema);
 const pool=makeDb(isolated.href);
 try {
  await db.query("CREATE SCHEMA "+schema);
  await setupDb(pool);
  const raw=[{x:0,properties:{id_7:false}},{x:"",properties:{}},{x:null},{x:"2"},{}];
  for (const [index,data] of raw.entries()) {
   await pool.query("INSERT INTO kaiten_cards(id,space_id,title,data,estimate_raw,estimate_unit) VALUES($1,15,'PRIVATE',$2,'5'::jsonb,'h')",[index+1,data]);
  }
  await pool.query("INSERT INTO kaiten_cards(id,space_id,title,data) VALUES(99,16,'PRIVATE','{}')");
  const report=await diagnosticSnapshot(pool,15);
  const x=report.fields.find(row=>row.scope==="JSON"&&row.field==="x");
  assert.deepEqual([x.total,x.present,x.null,x.empty,x.zero,x.filled,x.mixed],[5,4,1,1,1,1,true]);
  assert.equal(report.fields.find(row=>row.scope==="JSON"&&row.field==="created").present,0);
  assert.equal(report.fields.find(row=>row.scope==="Свойство"&&row.field==="7").filled,1);
  assert.deepEqual(report.units,[{unit:"h",cards:5}]);
  assert.equal(report.summary.cards,5);
 } finally {
  await pool.end();
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE");
  await db.end();
 }
});

test("API deadline retains completed checks and explains skipped checks",async()=>{
 let elapsed=0;
 let calls=0;
 const report=await runDiagnostics({pool:fakePool(),config,now,pause,clock:()=>elapsed,fetcher:async()=>{
  calls++;
  elapsed=120001;
  return Response.json([]);
 }});
 assert.equal(calls,1);
 assert.equal(report.coverage.checked,1);
 assert.ok(report.coverage.skipped>0);
 assert.equal(report.probes[0].result,"пустой ответ");
 assert.match(report.probes.at(-1).result,/общий лимит времени/);
 assert.match(diagnosticsPanel({report,running:false},String),/завершена частично/);
});
