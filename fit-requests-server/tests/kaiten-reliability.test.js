import assert from "node:assert/strict";
import {test} from "node:test";
import {makeDb,setupDb,setupEnrichment,setupReliability} from "../src/db.js";
import {runEnrichment} from "../src/enrichment.js";
import {makeEnrichmentMigration} from "../src/enrichment-migration.js";
import {loadCardHistory} from "../src/history.js";
import {dailySlot,makeKaitenReliability} from "../src/kaiten-reliability.js";
import {readKaitenCoverage} from "../src/kaiten-coverage.js";

const config={spaceId:15,kaitenBase:"https://example.kaiten.ru",kaitenToken:"fixture"};
const wait=async()=>{};

test("daily window opens at 06:00 Novosibirsk",()=>{
 assert.equal(dailySlot(new Date("2026-11-28T22:59:59Z")).slot,"2026-11-28");
 assert.equal(dailySlot(new Date("2026-11-28T23:00:00Z")).slot,"2026-11-29");
 assert.equal(dailySlot(new Date("2026-11-28T23:00:00Z")).next.toISOString(),"2026-11-29T23:00:00.000Z");
});

test("additive migration, checklist outcomes, author evidence, and durable guarded runs",
 {skip:!process.env.ANALYTICS_TEST_DATABASE_URL},async()=>{
 const url=new URL(process.env.ANALYTICS_TEST_DATABASE_URL);
 const admin=makeDb(url.href);
 const name="reliability_test_"+process.pid;
 url.pathname="/"+name;
 const pool=makeDb(url.href);
 const databaseLimit=64*1024*1024;
 let throttled=false;
 const fetcher=async url=>{
  const path=url.pathname;
  if(path.endsWith("/location-history"))return Response.json([
   {id:10,card_id:20,changed:"2025-01-01T00:00:00Z",author_id:7},
   {id:11,card_id:20,changed:"2025-01-02T00:00:00Z",author_id:null},
   {id:12,card_id:20,changed:"2025-01-03T00:00:00Z"}
  ]);
  if(path.endsWith("/boards")&&throttled)return new Response(null,{status:429,headers:{"Retry-After":"3600"}});
  if(path.endsWith("/20"))return Response.json({id:20,description:"Fixture",checklists:[]});
  if(path.endsWith("/21"))return Response.json({id:21});
  if(path.endsWith("/22"))return Response.json({id:22,checklists:null});
  if(path.endsWith("/23"))return new Response(null,{status:403});
  if(path.endsWith("/428033"))return Response.json({id:428033,name:"Priority"});
  return Response.json([]);
 };
 try {
  await admin.query("CREATE DATABASE "+name);
  await setupDb(pool);
  await setupEnrichment(pool);
  const manager=()=>makeKaitenReliability({pool,config,databaseLimit,fetcher,wait,enabled:false});
  assert.equal((await manager().status()).available,false);
  await pool.query(`INSERT INTO kaiten_cards (id,space_id,title,updated_at,data) VALUES
   (20,15,'Fixture',now(),'{"created":"2026-01-01T00:00:00Z","properties":{"id_428033":218940}}'),
   (21,15,'Fixture',now(),'{}'),(22,15,'Fixture',now(),'{}'),(23,15,'Fixture',now(),'{}')`);
  const before=await readKaitenCoverage(pool,15);
  assert.equal(before.fields.priority,1);
  assert.equal(before.priority_by_group[0].year,2026);
  const migration=makeEnrichmentMigration({pool,space:15,reliability:true,blocked:()=>false});
  const {token}=await migration.prepare("admin session");
  await assert.rejects(migration.apply("other session",token,true),{status:403});
  await assert.rejects(migration.apply("admin session",token,false),{status:403});
  const lock=await pool.connect();
  try {
   await lock.query("BEGIN; LOCK TABLE kaiten_location_events IN ACCESS SHARE MODE");
   await assert.rejects(migration.apply("admin session",token,true),/не освободил таблицы/);
  } finally {await lock.query("ROLLBACK");lock.release();}
  assert.equal((await manager().status()).available,false);
  const approval=await migration.prepare("admin session");
  assert.deepEqual(await migration.apply("admin session",approval.token,true),{applied:true,counts:{events:0,histories:0}});
  assert.equal((await migration.prepare("admin session")).applied,true);
  await setupReliability(pool);
  const counts=await runEnrichment({pool,config,mode:"initial",sources:["checklists"],fetcher,wait});
  assert.equal(counts.empty,1);
  assert.equal(counts.error,2);
  assert.equal(counts.forbidden,1);
  await pool.query(`INSERT INTO kaiten_location_events(space_id,card_id,event_id,changed_at) VALUES(15,20,13,'2025-01-01')`);
  await loadCardHistory({pool,config,cardId:"20",fetcher,wait});
  await loadCardHistory({pool,config,cardId:"20",fetcher,wait});
  const coverage=await readKaitenCoverage(pool,15);
  assert.deepEqual(coverage.authors,{total:4,withAuthor:1,noAuthor:1,fieldMissing:1,unprocessed:1,failed:0});
  assert.ok(coverage.sources.some(row=>row.source==="checklists"&&row.http_status===200&&row.result==="error"&&row.total===2));
  const primary=manager();
  const other=manager();
  const outcomes=await Promise.all([primary.start(),other.start()]);
  assert.equal(outcomes.filter(value=>value==="progress").length,1);
  assert.equal((await manager().status()).run.phase,0);
  await manager().tick();
  assert.equal((await manager().status()).run.phase,1);
  for(let i=0;i<12&&(await manager().status()).run.phase<4;i++) await manager().tick();
  assert.equal((await manager().status()).run.phase,4);
  const completed=await manager().status();
  assert.equal(completed.enabled,false);
  assert.equal(completed.run.kind,"manual");
  assert.ok(completed.run.requests>0);
  assert.ok(completed.run.database_after);
  await manager().start("authors");
  while (!(await manager().status()).run.finished_at) await manager().tick();
  assert.equal((await manager().status()).run.kind,"authors");
  assert.equal((await pool.query("SELECT value->>'rr_priority' AS priority FROM kaiten_observed_snapshots WHERE card_id=20")).rows[0].priority,"218940");
  await pool.query(`UPDATE kaiten_cards SET synced_at=now(),updated_at=updated_at+interval '1 second',
   data=jsonb_set(data,'{properties,id_428033}','218941') WHERE id=20`);
  await manager().start();
  for(let i=0;i<15&&(await manager().status()).run.phase<4;i++) await manager().tick();
  const {rows}=await pool.query(`SELECT old_values->>'rr_priority' AS old,
   new_values->>'rr_priority' AS new,event_at FROM kaiten_observed_changes WHERE card_id=20`);
  assert.deepEqual(rows,[{old:"218940",new:"218941",event_at:null}]);
  throttled=true;
  let result=await manager().start();
  for(let i=0;i<8&&result!=="429";i++) result=await manager().tick();
  assert.equal(result,"429");
  assert.equal(await manager().tick(),"deferred");
  assert.ok((await manager().status()).run.outcome.retryAfter>Date.now()+3500000);
  await pool.query("UPDATE kaiten_reliability_runs SET finished_at=now() WHERE kind='manual'");
  await pool.query(`INSERT INTO kaiten_reliability_runs(space_id,kind,slot,started_at,finished_at,database_before)
   VALUES (15,'daily',$1,now()-interval '20 minutes',now()-interval '19 minutes',0)`,[dailySlot().slot]);
  const automatic=makeKaitenReliability({pool,config,databaseLimit,fetcher,wait,enabled:true});
  assert.equal(await automatic.tick(),"progress");
  assert.equal((await automatic.status()).run.kind,"urgent");
  assert.equal(await automatic.tick(),"finished");
  assert.equal(await automatic.tick(),undefined);
 } finally {
  await pool.end();
  await admin.query("DROP DATABASE IF EXISTS "+name);
  await admin.end();
 }
});
