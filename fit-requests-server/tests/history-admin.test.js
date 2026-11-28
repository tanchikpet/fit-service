import assert from "node:assert/strict";
import test from "node:test";
import {historyAccess, makeHistoryAdmin} from "../src/history-admin.js";

const ids = ["1","2","3","4","5","6"];
const config = {spaceId:42};
const counts = {cards:10,loaded:0,pending:10,errors:0,events:0,lastSuccess:null};
const check = async () => ({ids,counts,freeBytes:100000000,databaseBytes:5000000});
const pool = {query:async () => ({rows:[counts]})};
function pass(options,{inserted=0,error=0}={}) {
 const selected = options.ids.length || 10;
 const data = {selected,processed:selected,inserted,received:6,loaded:selected-error,empty:0,
  error,forbidden:0,not_found:0,result:error ? "error" : "loaded",status:error ? 503 : 200};
 options.onProgress(data);
 return data;
}

test("history controls require an administrator and the same origin for every POST",() => {
 const admin = {role:"admin"};
 assert.equal(historyAccess(null,"GET",true),401);
 assert.equal(historyAccess(null,"POST",true),401);
 assert.equal(historyAccess({role:"employee"},"POST",true),403);
 assert.equal(historyAccess(admin,"GET",false),200);
 assert.equal(historyAccess(admin,"POST",false),403);
 assert.equal(historyAccess(admin,"POST",true),200);
 assert.equal(historyAccess(admin,"DELETE",true),405);
});

test("full run requires readiness, successful replay and confirmed disk capacity",async () => {
 const calls = [];
 const controller = makeHistoryAdmin({config,pool,check,refresh:async options=>{
  calls.push(options.ids);
  return pass(options,{inserted:calls.length===1 ? 6 : 0});
 }});
 assert.throws(()=>controller.start("trial"),{status:409});
 controller.start("check");
 await controller.settle();
 assert.throws(()=>controller.start("pending",{volumeChecked:true}),{status:409});
 controller.start("trial");
 await controller.settle();
 assert.deepEqual(calls,[ids,ids]);
 assert.equal((await controller.status()).trial.passed,true);
 assert.throws(()=>controller.start("pending"),{status:409});
 controller.start("pending",{volumeChecked:true});
 await controller.settle();
 assert.deepEqual(calls,[ids,ids,[]]);
});

test("concurrent launch is rejected and stopping allows the current card to settle",async () => {
 let release;
 const pause = new Promise(resolve=>{release=resolve;});
 const controller = makeHistoryAdmin({config,pool,check,refresh:async options=>{
  await pause;
  assert.equal(options.shouldStop(),true);
  return pass(options);
 }});
 controller.start("check");
 await controller.settle();
 controller.start("trial");
 assert.throws(()=>controller.start("trial"),{status:409});
 controller.start("stop");
 assert.equal((await controller.status()).job.stop,true);
 release();
 await controller.settle();
 assert.equal((await controller.status()).job.state,"stopped");
 assert.equal((await controller.status()).trial.passed,false);
});

for (const [name,first,second] of [
 ["API failure",{error:1},{}],
 ["second pass adds rows",{inserted:6},{inserted:1}]
]) {
 test(name+" prevents a full load",async () => {
  let calls=0;
  const controller=makeHistoryAdmin({config,pool,check,refresh:async options=>{
   const result=pass(options,calls++===0?first:second);
   if (result.error) assert.equal(options.shouldStop(),true);
   return result;
  }});
  controller.start("check");
  await controller.settle();
  controller.start("trial");
  await controller.settle();
  assert.equal((await controller.status()).trial.passed,false);
  assert.throws(()=>controller.start("pending",{volumeChecked:true}),{status:409});
 });
}
