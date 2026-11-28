import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb, setupDb} from '../src/db.js';
import {initRequests, createRequest, updateRequest, deleteRequest, listRequests} from '../src/requests.js';
import {initCardCreation, description} from '../src/kaiten-create.js';
import {cleanSchema, migrateFormCatalog, manageCatalog, adminCatalog, publicCatalog, readVersion} from '../src/form-catalog.js';
import {allFields, legacyKinds, legacySchema, validateAnswers} from '../public/ui/form-schema.js';

const url=process.env.REQUEST_ACCESS_TEST_DATABASE_URL;
const admin={role:'admin',telegram_id:'999'};
const employee={role:'employee',telegram_id:'111',display_name:'Автор'};
const opts={catalog:true};
const field=(id,type,extra={})=>({id,type,label:id,required:false,defaultValue:null,options:[],...extra});

test('all input types preserve zero, false and option identifiers',()=>{
 const schema=legacySchema('other');
 const option={id:'russia',label:'Россия'};
 const fields=[
  field('field-count','number',{required:true}),field('field-flag','boolean',{required:true}),
  field('field-regions','multi',{required:true,options:[option]}),
  field('field-region','select',{options:[option]}),field('field-date','date'),field('field-url','url')
 ];
 schema.sections.push({id:'details',name:'Дополнительно',fields});
 const clean=cleanSchema(schema);
 const answers={title:'Название',owner:'Ответственный',description:'Описание','field-count':0,'field-flag':false,
  'field-regions':['russia'],'field-region':'russia','field-date':'2026-02-28','field-url':'https://example.org/'};
 assert.equal(validateAnswers(clean,answers),null);
 for(const [key,value] of Object.entries({'field-count':'0','field-flag':'false','field-regions':['russia','russia'],
  'field-region':'Россия','field-date':'2026-02-30','field-url':'ftp://example.org/'})){
  assert.equal(validateAnswers(clean,{...answers,[key]:value}).key,key);
 }
 assert.equal(validateAnswers(clean,{},true),null);
 assert.throws(()=>cleanSchema({...schema,sections:[{id:'main',name:'',fields:[]}]}),/Системное поле/);
});

test('migration and published form lifecycle in isolated PostgreSQL',{skip:!url},async()=>{
 const root=makeDb(url);
 const schemaName='forms_test_'+process.pid;
 const scopedUrl=new URL(url);scopedUrl.searchParams.set('options','-c search_path='+schemaName);
 const db=makeDb(scopedUrl.href);
 try{
  await root.query('CREATE SCHEMA '+schemaName);
  await setupDb(db);await initRequests(db);await initCardCreation(db);
  const historical={pageAction:'new',title:'Старая акция',status:'Новая',sourceId:'0007'};
  const oldDraft={requestKind:'other',title:'Старый черновик',status:'Черновик'};
  await db.query("INSERT INTO fit_requests(id,payload,created_by,updated_by,revision,kaiten_card_id) VALUES ('REQ-99',$1,'111','111',7,123),('REQ-98',$2,'111','111',1,NULL)",
   [JSON.stringify(historical),JSON.stringify(oldDraft)]);
  await db.query("INSERT INTO fit_requests_audit(request_id,editor_id,action,revision,payload) VALUES ('REQ-99','111','create',1,$1)",[JSON.stringify(historical)]);
  await migrateFormCatalog(db);await migrateFormCatalog(db);
  const catalog=await publicCatalog(db);
  assert.deepEqual(catalog.map(v=>[v.typeId,v.number,allFields(v.schema).length,allFields(v.schema).filter(f=>f.required).length]),
   [['new',1,21,14],['update',1,14,10],['other',1,8,3]]);
  for(const version of catalog)assert.deepEqual(version.schema,legacySchema(version.typeId));
  const {rows:[legacy]}=await db.query("SELECT * FROM fit_requests WHERE id='REQ-99'");
  assert.deepEqual(legacy.payload,historical);
  assert.equal(legacy.created_by,'111');assert.equal(legacy.revision,7);assert.equal(legacy.kaiten_card_id,'123');
  assert.equal(legacy.form_version_id,catalog[0].id);
  assert.equal((await db.query("SELECT form_version_id FROM fit_requests_audit WHERE request_id='REQ-99'")).rows[0].form_version_id,catalog[0].id);
  assert.equal(description(legacy,catalog[0]),description(legacy));
  assert.equal((await listRequests(db,admin)).items.some(item=>item.id==='REQ-98'),false);

  const rows=await manageCatalog(db,admin,{action:'create',name:'Интеграция'});
  const typeId=rows.find(row=>!legacyKinds.includes(row.id)).id;
  const act=async(action,extra={})=>{
   const item=(await adminCatalog(db)).find(row=>row.id===typeId);
   return manageCatalog(db,admin,{action,id:typeId,revision:item.revision,...extra});
  };
  const draftSchema=structuredClone(rows.find(row=>row.id===typeId).draft);
  draftSchema.sections[0].fields[0].label='Название интеграции';
  draftSchema.sections.push({id:'details',name:'Параметры',fields:[field('field-flag','boolean',{required:true})]});
  await act('save',{schema:draftSchema,position:4});
  await act('publish',{schema:draftSchema,position:4});
  await act('state',{state:'active'});
  const v1=(await publicCatalog(db)).find(v=>v.typeId===typeId);
  const first=await createRequest(db,employee,{requestKind:typeId,formVersionId:v1.id,status:'Черновик',formAnswers:{title:'Платёж','field-flag':false}},opts);
  const v2Schema=structuredClone(draftSchema);
  v2Schema.name='Интеграции';v2Schema.sections[1].fields=[field('field-region','text',{required:true})];
  await act('publish',{schema:v2Schema,position:4});
  assert.equal((await readVersion(db,v1.id)).schema.name,'Интеграция');
  await assert.rejects(()=>createRequest(db,employee,{requestKind:typeId,formVersionId:v1.id,formAnswers:{title:'Старая вкладка','field-flag':false}},opts),{status:409,code:'form_changed'});
  await act('state',{state:'inactive'});
  const submitted=await updateRequest(db,employee,first.id,{revision:first.revision,formVersionId:v1.id,status:'Новая'},opts);
  assert.equal(submitted.formVersion.id,v1.id);
  assert.equal(submitted.formAnswers['field-flag'],false);
  assert.equal(submitted.title,'Платёж');
  assert.match(description({id:first.id,payload:submitted},v1),/field-flag:\nНет/);
  await act('state',{state:'active'});
  const v2=(await publicCatalog(db)).find(v=>v.typeId===typeId);
  const second=await createRequest(db,employee,{requestKind:typeId,formVersionId:v2.id,status:'Черновик'},opts);
  await act('state',{state:'archived'});
  await assert.rejects(()=>updateRequest(db,employee,second.id,{revision:second.revision,status:'Новая'},opts),{status:409});
  assert.equal((await listRequests(db,employee)).items.find(item=>item.id===second.id).formVersion.state,'archived');
  await assert.rejects(()=>act('delete'),{status:409});
  await deleteRequest(db,employee,second.id,{revision:second.revision});
  await deleteRequest(db,employee,first.id,{revision:submitted.revision});
  await assert.rejects(()=>act('delete'),{status:409});
  await act('restore',{versionId:v1.id});
  const restored=(await adminCatalog(db)).find(row=>row.id===typeId);
  await act('publish',{schema:restored.draft,position:4});
  assert.deepEqual((await readVersion(db,(await adminCatalog(db)).find(row=>row.id===typeId).current_version_id)).schema,v1.schema);
  const clean=(await adminCatalog(db)).find(row=>row.id==='update');
  await manageCatalog(db,admin,{action:'delete',id:clean.id,revision:clean.revision});
  await migrateFormCatalog(db);
  assert.ok(!(await adminCatalog(db)).some(row=>row.id==='update'));
 }finally{
  await db.end();
  await root.query('DROP SCHEMA IF EXISTS '+schemaName+' CASCADE');
  await root.end();
 }
});
