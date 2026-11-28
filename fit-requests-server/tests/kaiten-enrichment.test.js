import assert from "node:assert/strict";
import {test} from "node:test";
import {makeDb,setupDb,setupEnrichment} from "../src/db.js";
import {makeEnrichmentApi} from "../src/enrichment-api.js";
import {runEnrichment} from "../src/enrichment.js";
import {loadCardHistory} from "../src/history.js";
import {probeTargetedActivity} from "../src/kaiten-targeted-activity.js";

const config={spaceId:15,kaitenBase:"https://example.kaiten.ru",kaitenToken:"fixture"};
const wait=async()=>{};
const ok=data=>Response.json(data);

test("uses the applied limit and greatest space-user ID; refuses repeated pages",async()=>{
 const calls=[];
 const api=makeEnrichmentApi({config,wait,fetcher:async(url,options)=>{
  assert.equal(options.method,"GET");
  assert.equal(options.redirect,"error");
  calls.push(url);
  return Response.json(calls.length===1?[{id:3},{id:1}]:[{id:7}],{headers:{"X-Pagination-Limit":"2"}});
 }});
 assert.deepEqual(await api.list("/spaces/15/users","user"),[{id:3},{id:1},{id:7}]);
 assert.equal(calls[1].searchParams.get("last_user_id"),"3");
 const repeated=makeEnrichmentApi({config,wait,fetcher:async()=>Response.json([{id:1}],{headers:{"X-Pagination-Limit":"1"}})});
 await assert.rejects(repeated.list("/tags","offset"),/repeated/);
});

test("bounded activity supports ID-only events and counts explicit old/new changes",async()=>{
 const pool={connect:async()=>({query:async sql=>sql.startsWith("WITH")?
  {rows:[{examples:["20"],column_id:"3189879"}]}:{},release(){}})};
 const report=await probeTargetedActivity({pool,config,wait,fetcher:async(url)=>{
  assert.equal(url.pathname,"/api/latest/spaces/15/activity");
  assert.equal(url.searchParams.get("limit"),"20");
  if(url.searchParams.get("actions")?.includes("card_update"))return ok({items:[
   {id:"99",created:"2025-04-01T01:00:00Z",action:"card_update",card_id:20,author_id:7,
    data:{old:{due_date:null},new:{due_date:"2025-05-01"}}}
  ],next_cursor:null});
  return ok({items:[],next_cursor:null});
 }});
 assert.equal(report.requests,14);
 assert.equal(report.evidence[0].author,"7");
 assert.deepEqual(report.evidence[0].fields,["due_date"]);
 assert.equal(report.probes.find(row=>row.label==="Карточки и поля").entityMatches,1);
 assert.equal(report.names.length,0);
 assert.doesNotMatch(JSON.stringify(report),/2025-05-01|fixture/);
});

test("enrichment versions dictionaries, resumes changed sources and fills only missing authors",
 {skip:!process.env.ANALYTICS_TEST_DATABASE_URL},async()=>{
 const admin=makeDb(process.env.ANALYTICS_TEST_DATABASE_URL);
 const schema="enrichment_test_"+process.pid;
 const scoped=new URL(process.env.ANALYTICS_TEST_DATABASE_URL);
 scoped.searchParams.set("options","-c search_path="+schema);
 const pool=makeDb(scoped.href);
 try {
  await admin.query("CREATE SCHEMA "+schema);
  await setupDb(pool);
  await setupEnrichment(pool);
  await setupEnrichment(pool);
  await pool.query(`INSERT INTO kaiten_cards(id,space_id,title,updated_at,data) VALUES
   (20,15,'Card','2026-01-01T00:00:00Z','{"tag_ids":[6],"children_ids":[],"properties":{"id_428033":5}}')`);
  await pool.query(`INSERT INTO kaiten_location_events(space_id,card_id,event_id,changed_at,board_id,column_id)
   VALUES(15,20,10,'2025-01-01',898832,3189879)`);
  let board="First", fail=false, commentsDenied=false;
  const fetcher=async url=>{
   const path=url.pathname.replace("/api/latest","");
   if (path.endsWith("/boards")) {
    if (fail) return new Response(null,{status:403});
    return ok([{id:1,title:board}]);
   }
   if (path.endsWith("/users")) return ok([{id:7,full_name:"Display",email:"private@example.com",avatar:"private"}]);
   if (path.endsWith("/custom-properties")) return ok([{id:428033,name:"Priority fixture",type:"select"}]);
   if (path.endsWith("/select-values")) return ok([{id:5,value:"High"}]);
   if (path==="/cards/20") return ok({id:20,description:"Description",properties:{id_428033:5},checklists:[],files:[{id:55}]});
   if (path.endsWith("/members")) return ok([{id:7,user_id:7,type:2,email:"private@example.com"}]);
   if (path==="/cards/20/tags") return ok([{id:6}]);
   if (path.endsWith("/comments")) return commentsDenied ? new Response(null,{status:403}) : ok([{id:80,text:"Comment",created:"2026-01-01",email:"private@example.com"}]);
   if (path.endsWith("/location-history")) return ok([{id:"10",card_id:20,board_id:88,column_id:77,
    changed:"2026-01-01T00:00:00Z",condition:1,author_id:7}]);
   return ok([]);
  };
  const run=(mode,cardId)=>runEnrichment({pool,config,mode,limit:5,cardId,fetcher,wait});
  await run("dictionaries");
  await run("dictionaries");
  board="Renamed";
  await run("dictionaries");
  fail=true;
  await run("dictionaries");
  const boards=(await pool.query("SELECT value,replaced_at FROM kaiten_dictionary_versions WHERE source='boards' ORDER BY version_id")).rows;
  assert.deepEqual(boards.map(r=>r.value.title),["First","Renamed"]);
  assert.ok(boards[0].replaced_at);
  assert.equal(boards[1].replaced_at,null);
  assert.doesNotMatch(JSON.stringify((await pool.query("SELECT value FROM kaiten_dictionary_versions WHERE source='users'")).rows),/email|avatar|private/);
  await run("initial");
  assert.equal((await run("pending")).requests,0);
  assert.equal((await pool.query("SELECT payload FROM kaiten_enrichment_sources WHERE source='detail'")).rows[0].payload.description,"Description");
  assert.equal((await pool.query("SELECT payload FROM kaiten_enrichment_sources WHERE source='detail'")).rows[0].payload.properties,undefined);
  assert.deepEqual((await pool.query("SELECT payload FROM kaiten_enrichment_sources WHERE source='tags' AND subject='20'")).rows[0].payload,[]);
  commentsDenied=true;
  await run("pending","20");
  const comments=(await pool.query("SELECT result,payload FROM kaiten_enrichment_sources WHERE source='comments'")).rows[0];
  assert.equal(comments.result,"forbidden");
  assert.equal(comments.payload[0].text,"Comment");
  assert.equal(comments.payload[0].email,undefined);
  for (let i=0;i<2;i++)await loadCardHistory({pool,config,cardId:"20",fetcher,wait});
  assert.deepEqual((await pool.query("SELECT event_id::int,author_id::int,board_id::int,to_char(changed_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day FROM kaiten_location_events")).rows,
   [{event_id:10,author_id:7,board_id:898832,day:"2025-01-01"}]);
  const activity=await probeTargetedActivity({pool,config,wait,fetcher:async()=>ok({items:[],next_cursor:null})});
  assert.equal(activity.routes[0].column_id,"3189879");
  assert.deepEqual(activity.routes[0].examples,["20"]);
 } finally {
  await pool.end();
  await admin.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE");
  await admin.end();
 }
});
