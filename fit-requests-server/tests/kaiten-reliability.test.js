import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {makeDb,setupDb,setupEnrichment} from "../src/db.js";
import {runEnrichment} from "../src/enrichment.js";
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
  const migration=await readFile(new URL("../migrations/003-kaiten-reliability.sql",import.meta.url),"utf8");
  await pool.query(migration);
  await pool.query(migration);
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
  assert.equal((await manager().status()).run.phase,1);
  await manager().tick();
  assert.equal((await manager().status()).run.batches,1);
  for(let i=0;i<12&&(await manager().status()).run.phase<6;i++) await manager().tick();
  assert.equal((await manager().status()).run.phase,6);
  assert.equal((await manager().status()).enabled,false);
  assert.equal((await pool.query("SELECT value->>'rr_priority' AS priority FROM kaiten_observed_snapshots WHERE card_id=20")).rows[0].priority,"218940");
  await pool.query(`UPDATE kaiten_cards SET synced_at=now(),updated_at=updated_at+interval '1 second',
   data=jsonb_set(data,'{properties,id_428033}','218941') WHERE id=20`);
  await manager().start();
  for(let i=0;i<15&&(await manager().status()).run.phase<6;i++) await manager().tick();
  const {rows}=await pool.query(`SELECT old_values->>'rr_priority' AS old,
   new_values->>'rr_priority' AS new,event_at FROM kaiten_observed_changes WHERE card_id=20`);
  assert.deepEqual(rows,[{old:"218940",new:"218941",event_at:null}]);
  throttled=true;
  assert.equal(await manager().start(),"429");
  assert.equal(await manager().tick(),"deferred");
  assert.ok((await manager().status()).run.outcome.retryAfter>Date.now()+3500000);
 } finally {
  await pool.end();
  await admin.query("DROP DATABASE IF EXISTS "+name);
  await admin.end();
 }
});
