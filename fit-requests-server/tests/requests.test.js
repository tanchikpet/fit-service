import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequest,updateRequest,deleteRequest} from '../src/requests.js';
import {activeFields,isRequired,validateRequestFields} from '../public/ui/request-fields.js';
const user={telegram_id:'111',display_name:'Автор',role:'employee'};
const full=kind=>({requestKind:kind,...Object.fromEntries(activeFields(kind).filter(f=>isRequired(f,kind)).map(([k,,type])=>[k,type==='url'?'https://fitauto.ru/':type==='date'?'2026-12-01':'Тест'])),sourceId:kind==='new'?'000000237':undefined,status:'Новая'});
function database(row=null,pending=false){
 const state={row,audit:[],calls:[],released:false};let snapshot;
 const client={release(){state.released=true},async query(sql,args=[]){
  state.calls.push(sql);
  if(sql==='BEGIN'){snapshot=structuredClone({row:state.row,audit:state.audit});return {rows:[]}}
  if(sql==='ROLLBACK'){Object.assign(state,snapshot);return {rows:[]}}
  if(sql==='COMMIT')return {rows:[]};
  if(sql.startsWith('SELECT pg_advisory_xact_lock'))return {rows:[]};
  if(sql.startsWith('SELECT request_id,action,payload')){
   const found=state.audit.find(event=>event.args[1]===args[0]&&JSON.parse(event.args.at(-1))._mutation?.operationId===args[1]);
   return {rows:found?[{request_id:found.args[0],action:found.sql.includes("'create'")?'create':'update',payload:JSON.parse(found.args.at(-1))}]:[]};
  }
  if(sql.startsWith('SELECT r.id'))return {rows:state.row?[structuredClone(state.row)]:[]};
  if(sql.startsWith('SELECT nextval'))return {rows:[{n:1001}]};
  if(sql.startsWith('SELECT * FROM fit_requests'))return {rows:state.row?[structuredClone(state.row)]:[]};
  if(sql.startsWith('SELECT status FROM fit_kaiten_creation_attempts'))return {rows:pending?[{status:'pending'}]:[]};
  if(sql.startsWith('INSERT INTO fit_requests(')){state.row={id:args[0],payload:JSON.parse(args[1]),created_by:args[2],revision:1};return {rows:[structuredClone(state.row)]}}
  if(sql.startsWith('UPDATE fit_requests SET payload')){state.row.payload=JSON.parse(args[1]);state.row.revision++;return {rows:[structuredClone(state.row)]}}
  if(sql.startsWith('INSERT INTO fit_requests_audit')){state.audit.push({sql,args});return {rows:[]}}
  if(sql.startsWith('DELETE FROM fit_requests WHERE')){state.row=null;return {rows:[],rowCount:1}}
  throw Error('Unexpected SQL: '+sql);
 }};
 return {state,connect:async()=>client};
}
for(const kind of ['new','update','other'])test(kind+': fields survive server validation and save',async()=>{
 const db=database();const saved=await createRequest(db,user,full(kind));
 assert.equal(saved.requestKind,kind);assert.equal(saved.createdBy,user.telegram_id);
 for(const [key] of activeFields(kind).filter(f=>isRequired(f,kind)))assert.equal(saved[key],full(kind)[key]);
 if(kind==='new')assert.equal(saved.sourceId,'000000237');
});
test('all required fields are enforced on the server',async()=>{
 for(const kind of ['new','update','other'])for(const [key] of activeFields(kind).filter(f=>isRequired(f,kind))){
  const body=full(kind);delete body[key];await assert.rejects(()=>createRequest(database(),user,body),{message:/Заполни/,field:key});
 }
});
test('draft accepts missing fields; submitted request rejects invalid dates and links',async()=>{
 const draft=await createRequest(database(),user,{requestKind:'new',status:'Черновик'});assert.equal(draft.status,'Черновик');
 for(const extra of [{actualUrl:'javascript:alert(1)'},{actualUrl:'https://user:password@example.org'}])await assert.rejects(()=>createRequest(database(),user,{...full('other'),...extra}),/ссылк/);
 assert.ok(validateRequestFields({...full('new'),campaignStart:'2026-02-30'}));
 assert.ok(validateRequestFields({...full('new'),campaignEnd:'2026-11-01'}));
 assert.equal(validateRequestFields({...full('other'),campaignStart:'2026-02-30'}),null);
});
test('employee cannot change project, ownership or execution fields',async()=>{
 const db=database();const item=await createRequest(db,user,{...full('other'),createdBy:'222',project:'site',priority:'Критический'});
 assert.equal(item.createdBy,'111');assert.equal(item.project,'');assert.equal(item.priority,undefined);
 db.state.row.payload.project='fleet';
 const edited=await updateRequest(db,user,item.id,{...full('other'),revision:1,project:'site'});
 assert.equal(edited.project,'fleet');assert.equal(edited.revision,2);
});
test('update cannot bypass required campaign fields by omitting the scenario',async()=>{
 const db=database();const item=await createRequest(db,user,full('new'));
 await assert.rejects(()=>updateRequest(db,user,item.id,{revision:1,offer:''}),/Оффер/);
 assert.equal(db.state.row.revision,1);
});
const ownRow=()=>({id:'REQ-1001',created_by:'111',revision:3,payload:{...full('other'),status:'Черновик'},kaiten_card_id:123});
test('owner deletes own request with audit snapshot, never deletes a Kaiten card',async()=>{
 const db=database(ownRow());assert.deepEqual(await deleteRequest(db,user,'REQ-1001',{revision:3}),{ok:true});
 assert.equal(db.state.row,null);assert.equal(db.state.audit.length,1);assert.equal(db.state.released,true);
 assert.equal(JSON.parse(db.state.audit[0].args[3]).kaitenCardId,123);
 assert.ok(!db.state.calls.some(x=>x.includes('DELETE FROM kaiten')));
});
for(const role of ['employee','admin'])test(role+' cannot delete somebody else’s request',async()=>{
 const db=database({...ownRow(),created_by:'222'});
 assert.deepEqual(await deleteRequest(db,{...user,role},'REQ-1001',{revision:3}),{forbidden:true});assert.ok(db.state.row);assert.equal(db.state.audit.length,0);
});
test('missing record, stale revision and in-flight Kaiten creation do not delete',async()=>{
 assert.deepEqual(await deleteRequest(database(),user,'REQ-1001',{revision:3}),{notFound:true});
 const db=database(ownRow());assert.deepEqual(await deleteRequest(db,user,'REQ-1001',{revision:2}),{conflict:true});assert.ok(db.state.row);
 const pending=database(ownRow(),true);assert.deepEqual(await deleteRequest(pending,user,'REQ-1001',{revision:3}),{pending:true});assert.ok(pending.state.row);
 await assert.rejects(()=>deleteRequest(db,user,'REQ-1001',{}),/версия/);
});

test('draft retries and submission retain the same ID and audit each write once',async()=>{
 const db=database();
 const operationId='ba73243a-3051-4c89-827b-aa67cc9b54bf';
 const input={requestKind:'new',status:'Черновик',sourceId:'0001',plannedUrl:'незавершенный адрес',requester:'Подмена',operationId};
 const draft=await createRequest(db,user,input);
 assert.equal(draft.requester,'Автор');
 assert.equal(draft.plannedUrl,'незавершенный адрес');
 assert.equal((await createRequest(db,user,input)).id,draft.id);
 assert.equal(db.state.audit.length,1);
 await assert.rejects(()=>createRequest(db,user,{...input,sourceId:'0002'}),{status:409});
 const edited=await updateRequest(db,user,draft.id,{revision:1,status:'Черновик',title:'Черновик'});
 assert.equal(edited.id,draft.id);
 const submission={...full('other'),revision:2,operationId:'ea73243a-3051-4c89-827b-aa67cc9b54bf'};
 const saved=await updateRequest(db,user,draft.id,submission);
 assert.equal(saved.status,'Новая');
 assert.equal(saved.id,draft.id);
 assert.equal(saved.sourceId,'0001');
 assert.equal((await updateRequest(db,user,draft.id,submission)).revision,3);
 assert.equal(db.state.audit.length,3);
 await deleteRequest(db,user,draft.id,{revision:3});
 await assert.rejects(()=>createRequest(db,user,input),{status:409});
});
test('draft creation and submission have the same lifecycle for administrators',async()=>{
 const db=database();
 const admin={...user,role:'admin'};
 const draft=await createRequest(db,admin,{status:'Черновик',requestKind:'other'});
 const saved=await updateRequest(db,admin,draft.id,{...full('other'),revision:1,status:'Уточнение'});
 assert.equal(saved.status,'Новая');
 assert.equal(saved.id,draft.id);
});
test('PM routing can still update a submitted request missing task type and owner',async()=>{
 const db=database({id:'REQ-1001',created_by:'222',revision:1,payload:{title:'Ранее поданная',status:'Новая',requester:'Исторический автор'}});
 const saved=await updateRequest(db,{...user,role:'admin'},'REQ-1001',{revision:1,project:'site',status:'Уточнение'});
 assert.equal(saved.requestKind,undefined);
 assert.equal(saved.requester,'Исторический автор');
 assert.equal(saved.project,'site');
});
