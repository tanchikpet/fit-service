import test from "node:test";
import assert from "node:assert/strict";
import {normalizeCard,listKaitenCards} from "../src/kaiten.js";
import {loadConfig} from "../src/config.js";
test("normalization retains raw scale and different developer members",()=>{
 const c=normalizeCard({id:57259495,title:"Example",size:20,size_text:"20",owner_id:833107,members:[{id:833107},{id:184262}],state:2},332384);
 assert.equal(c.estimateRaw,20);assert.equal(c.ownerId,833107);assert.deepEqual(c.assigneeIds,[833107,184262]);
});
test("API pagination traverses full 100-item pages and uses updated_after",async()=>{
 let calls=0;
 const fetcher=async url=>{calls++;assert.equal(url.searchParams.get("space_id"),"332384");assert.equal(url.searchParams.get("updated_after"),"2026-11-01T00:00:00Z");assert.equal(Number(url.searchParams.get("offset")),(calls-1)*100);return {ok:true,json:async()=>calls===1?Array.from({length:100},(_,i)=>({id:i+1})): [{id:101}]}};
 const result=await listKaitenCards({base:"https://rossko.kaiten.ru",token:"test",spaceId:332384,updatedAfter:"2026-11-01T00:00:00Z",fetcher});
 assert.equal(result.cards.length,101);assert.equal(calls,2);
});
test("config refuses missing secret",()=>assert.throws(()=>loadConfig({DATABASE_URL:"test",KAITEN_API_TOKEN:"abc"})));
test("config rejects mixed secrets",()=>{
 const k="k".repeat(40),b="b".repeat(40);
 assert.throws(()=>loadConfig({DATABASE_URL:"postgres://a",KAITEN_API_TOKEN:k,ADMIN_API_TOKEN:b,KAITEN_WEBHOOK_SECRET:b}));
});
