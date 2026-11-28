import test from "node:test";
import assert from "node:assert/strict";
import {telegramAuth} from "../src/auth.js";
const pool={query:async()=>({rows:[]})};
test("closed login until all Telegram OIDC settings are configured",()=>{
 const auth=telegramAuth({pool,env:{PUBLIC_ORIGIN:"https://example.com",TELEGRAM_CLIENT_ID:"12345678",TELEGRAM_CLIENT_SECRET:"secret"}});
 assert.equal(auth.configured(),false);
});
test("valid HTTPS origin, Telegram client ID and initial administrator ID enable login",()=>{
 const env={PUBLIC_ORIGIN:"https://example.com",TELEGRAM_CLIENT_ID:"12345678",TELEGRAM_CLIENT_SECRET:"secret",TELEGRAM_ADMIN_ID:"123456789"};
 assert.equal(telegramAuth({pool,env}).configured(),true);
 assert.equal(telegramAuth({pool,env:{...env,PUBLIC_ORIGIN:"http://example.com"}}).configured(),false);
 assert.equal(telegramAuth({pool,env:{...env,TELEGRAM_ADMIN_ID:"@username"}}).configured(),false);
});
test("anonymous requests do not have access",async()=>{
 assert.equal(await telegramAuth({pool,env:{}}).user({headers:{}}),null);
});
