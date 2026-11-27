import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import {buildReport, localMonth, parentStatus, readReport, reportFilters, stageAt} from "../src/analytics.js";
import {analyticsWorkbook} from "../src/analytics-view.js";
import {makeDb, setupDb, upsertCards} from "../src/db.js";
import {refreshHistory} from "../src/history.js";
import {listKaitenLocations, normalizeCard} from "../src/kaiten.js";

const date = value => new Date(value);
const spaceId = 987654;
const board = "10";
const config = {spaceId,kaitenBase:"https://example.kaiten.ru",kaitenToken:"fixture-token"};
const filters = {from:"2026-01",to:"2026-04",board,parent:"all"};
const now = date("2026-03-15T00:00:00Z");
const edge = "2026-01-31T17:00:00.000Z";
const before = "2026-01-31T16:59:59.999Z";
const wait = async () => {};
const event = (id,card_id,board_id,changed,condition=1,column_id=90) =>
 ({id:String(id),card_id,board_id,changed,condition,column_id,subcolumn_id:91,lane_id:3,sprint_id:null});

test("Novosibirsk boundary, future months, parent evidence and dated stage mapping", () => {
 assert.equal(localMonth(date(before)), "2026-01");
 assert.equal(localMonth(date(edge)), "2026-02");
 assert.equal(parentStatus({parents_count:2,parents_ids:[1,2]}),"yes");
 assert.equal(parentStatus({parents_ids:null}),"no");
 assert.equal(parentStatus({}),"unknown");
 const dictionary = {stages:[
  {spaceId,boardId:"10",columnId:"90",from:"2026-01-01T00:00:00Z",to:edge,stage:"Очередь"},
  {spaceId,boardId:"10",columnId:"90",from:edge,to:null,stage:"Демо"}
 ]};
 assert.equal(stageAt(spaceId,board,"90",date(before),dictionary),"Очередь");
 assert.equal(stageAt(spaceId,board,"90",date(edge),dictionary),"Демо");
 assert.equal(stageAt(spaceId,board,"99",date(edge),dictionary),null);
 assert.throws(() => reportFilters(new URLSearchParams({from:"2026-04"}),now), RangeError);
 const pending = buildReport({spaceId,cards:[],events:[],syncAt:null,filters,now});
 assert.deepEqual(pending.months.map(month => [month.created,month.arrivals,month.partial]),
  [[null,null,false],[null,null,false],[null,null,true]]);
});

test("history retries throttling and temporary failures, and rejects unexpected pagination", async () => {
 const responses = [
  new Response("",{status:429,headers:{"Retry-After":"2"}}),
  new Response("",{status:503}),
  Response.json([event("9007199254740993",1,10,edge)])
 ];
 const delays = [];
 const events = await listKaitenLocations({base:config.kaitenBase,token:config.kaitenToken,cardId:"1",
  fetcher:async (url,options) => {
   assert.equal(url.pathname,"/api/latest/cards/1/location-history");
   assert.equal(url.search,"");
   assert.equal(options.headers.Authorization,"Bearer fixture-token");
   return responses.shift();
  },
  wait:async delay => {delays.push(delay);}
 });
 assert.equal(events[0].event_id,"9007199254740993");
 assert.equal(delays.length,2);
 assert.equal(delays[0],2000);
 await assert.rejects(listKaitenLocations({base:config.kaitenBase,token:config.kaitenToken,cardId:"1",
  fetcher:async () => Response.json([],{headers:{Link:'<?page=2>; rel="next"'}}),wait
 }),/Unexpected/);
});

test("PostgreSQL history and report survive reloading, denied access and a partial outage",
 {skip:!process.env.ANALYTICS_TEST_DATABASE_URL},async () => {
 const pool = makeDb(process.env.ANALYTICS_TEST_DATABASE_URL);
 const schema = "analytics_test_" + process.pid;
 const scopedUrl = new URL(process.env.ANALYTICS_TEST_DATABASE_URL);
 scopedUrl.searchParams.set("options","-c search_path=" + schema);
 const scoped = makeDb(scopedUrl.href);
 try {
  await pool.query("CREATE SCHEMA " + schema);
  await setupDb(scoped);
  await setupDb(scoped);
  const initial = [
   {id:1,created:before,board_id:10,column_id:90,condition:1,parents_count:0},
   {id:2,created:edge,board_id:20,column_id:92,condition:2,parents_ids:[1,8],archived:true},
   {id:3,created:edge,board_id:10,column_id:90,condition:1,parents_count:0},
   {id:4,created:edge,board_id:10,column_id:90,condition:1,parents_count:0},
   {id:5,created:edge,board_id:10,column_id:90,condition:1,parents_count:0},
   {id:6,created:edge,board_id:10,column_id:90,condition:2,parents_count:0,archived:true}
  ];
  await upsertCards(scoped,initial.map(card => normalizeCard(card,spaceId)));
  const source = {
   1:[event(3,1,10,"2026-02-03T00:00:00Z",2),event(4,1,10,"2026-02-04T00:00:00Z"),
    event(1,1,20,before),event(2,1,10,edge)],
   2:[event(12,2,20,"2026-03-05T00:00:00Z",2,92),event(11,2,10,"2026-03-01T00:00:00Z")],
   3:403, 4:[], 5:503,
   6:[event(16,6,10,before,1),event(17,6,10,edge,2)]
  };
  const attempts = {};
  let active = 0;
  let highWater = 0;
  const fetcher = async url => {
   const id = url.pathname.split("/")[4];
   attempts[id] = (attempts[id] || 0) + 1;
   highWater = Math.max(highWater,++active);
   await new Promise(resolve => setImmediate(resolve));
   active--;
   const body = source[id];
   return typeof body === "number" ? new Response(null,{status:body}) : Response.json(body);
  };
  const run = (mode,ids) => refreshHistory({pool:scoped,config,mode,ids,fetcher,wait});
  const expected = {selected:6,loaded:3,empty:1,forbidden:1,not_found:0,error:1};
  assert.deepEqual(await run("pending"),expected);
  assert.equal(attempts[3],1);
  assert.equal(attempts[5],4);
  assert.equal(highWater,2);
  assert.deepEqual(await run("all"),expected);
  assert.deepEqual((await scoped.query("SELECT count(*)::int AS n FROM kaiten_location_events")).rows,[{n:8}]);
  assert.deepEqual(await run("pending"),{selected:2,loaded:0,empty:0,forbidden:1,not_found:0,error:1});
  const {rows:[previous]} = await scoped.query("SELECT last_success_at FROM kaiten_history_loads WHERE card_id=1");
  source[1] = 503;
  source[2] = 404;
  await run("pending",["1","2"]);
  const {rows:[failed]} = await scoped.query("SELECT last_success_at,result,http_status FROM kaiten_history_loads WHERE card_id=1");
  assert.deepEqual(failed,{...previous,result:"error",http_status:503});
  // Current-state upserts do not delete or rewrite historical rows.
  await upsertCards(scoped,[normalizeCard({...initial[0],board_id:20,column_id:92,updated:"2026-03-12T00:00:00Z"},spaceId)]);
  const {rows:stored} = await scoped.query("SELECT event_id,board_id,column_id,subcolumn_id,lane_id,changed_at,condition FROM kaiten_location_events WHERE card_id=1 ORDER BY event_id");
  assert.deepEqual(stored[1],{event_id:"2",board_id:"10",column_id:"90",subcolumn_id:"91",lane_id:"3",changed_at:date(edge),condition:1});
  assert.deepEqual(stored.map(row => row.condition),[1,1,2,1]);
  await scoped.query("UPDATE kaiten_history_loads SET last_success_at=$1,last_attempt_at=$1 WHERE last_success_at IS NOT NULL",[now]);
  await scoped.query("INSERT INTO kaiten_sync_state(space_id,last_success_at) VALUES($1,$2)",[spaceId,now]);
  const report = await readReport(scoped,spaceId,filters,now);
  assert.deepEqual(report.months.map(month => [month.created,month.arrivals,month.partial]),
   [[0,1,false],[4,1,false],[0,1,true]]);
  assert.equal(report.coverage.successful,4);
  assert.equal(report.coverage.empty,1);
  assert.equal(report.coverage.forbidden,1);
  assert.equal(report.coverage.not_found,1);
  assert.equal(report.coverage.error,2);
  assert.equal(report.coverage.stale,2);
  assert.equal(report.statuses.find(row => row.status === "Архив").count,1);
  assert.deepEqual(report.unconfirmed,[{board:"10",column:"90",count:6}]);
  const child = await readReport(scoped,spaceId,{...filters,parent:"yes"},now);
  assert.deepEqual(child.months.map(month => [month.created,month.arrivals]),[[0,0],[0,0],[0,1]]);
  assert.deepEqual(child.statuses,[]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await analyticsWorkbook(report));
  assert.deepEqual(workbook.getWorksheet("По месяцам").getRow(3).values.slice(1),["2026-02",4,1,"Завершённый"]);
  assert.match(workbook.getWorksheet("Методология").getCell("B5").value,/Novosibirsk/);
 } finally {
  await scoped.end();
  await pool.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
  await pool.end();
 }
});
