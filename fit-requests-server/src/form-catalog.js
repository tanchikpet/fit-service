import {randomUUID} from 'node:crypto';
import {requestFields} from '../public/ui/request-fields.js';
import {allFields, fieldTypes, legacyKinds, legacySchema, valueError} from '../public/ui/form-schema.js';

export const formError=(message,status=400,extra={})=>Object.assign(new Error(message),{status,...extra});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const validId=value=>typeof value==='string'&&/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);
const legacyFieldIds=new Set(requestFields.map(([key])=>key));
const reservedIds=new Set(['id','status','created','createdBy','requester','requestKind','formAnswers','formVersionId',
 'project','revision','updatedAt','kaitenParent','kaiten','constructor','prototype','__proto__']);
function string(value,max,required=false){
 if(typeof value!=='string'||value.length>max||required&&!value.trim())throw formError('Проверь длину и заполнение текста');
 return value.trim();
}
export function cleanSchema(input, rules=[]) {
 if(!object(input)||!Array.isArray(input.sections)||!input.sections.length||input.sections.length>20)throw formError('Укажи от 1 до 20 разделов');
 const sectionIds=new Set(),fieldIds=new Set();
 const sections=input.sections.map(section=>{
  if(!object(section)||!validId(section.id)||sectionIds.has(section.id)||!Array.isArray(section.fields))throw formError('Некорректный раздел');
  sectionIds.add(section.id);
  return {id:section.id,name:string(section.name,120),fields:section.fields.map(field=>{
   if(!object(field)||(!legacyFieldIds.has(field.id)&&!(validId(field.id)&&field.id.startsWith('field-')))||reservedIds.has(field.id)||fieldIds.has(field.id)||!fieldTypes.includes(field.type))throw formError('Некорректное или повторяющееся поле');
   fieldIds.add(field.id);
   if(fieldIds.size>80)throw formError('Допустимо не более 80 полей');
   if(field.id==='title'&&(field.type!=='text'||field.required!==true))throw formError('Название заявки всегда обязательное текстовое поле');
   const choice=['select','multi'].includes(field.type);
   if(choice&&(!Array.isArray(field.options)||!field.options.length||field.options.length>100))throw formError('Добавь от 1 до 100 вариантов');
   const ids=new Set();
   const options=choice?field.options.map(option=>{
    if(!object(option)||!validId(option.id)||ids.has(option.id))throw formError('Повторяющийся или неверный ID варианта');
    ids.add(option.id);
    return {id:option.id,label:string(option.label,150,true)};
   }):[];
   const max=field.id==='title'?150:field.max??(field.type==='textarea'?10000:2048);
   if(!Number.isInteger(max)||max<1||max>10000)throw formError('Некорректная длина поля');
   const result={id:field.id,type:field.type,label:string(field.label,150,true),hint:string(field.hint??'',500),
    required:field.required===true,options,max,defaultValue:field.defaultValue??null};
   if(result.defaultValue!==null&&valueError({...result,required:false},result.defaultValue))throw formError('Проверь значение по умолчанию для «'+result.label+'»');
   return result;
  })};
 });
 if(!fieldIds.has('title'))throw formError('Системное поле названия обязательно');
 if(!['file','star','refresh','chart','link','flag'].includes(input.icon))throw formError('Выбери иконку');
 const fields=new Map(allFields({sections}).map(field=>[field.id,field]));
 return {name:string(input.name,120,true),description:string(input.description??'',500),icon:input.icon,sections,
  rules:rules.filter(rule=>fields.get(rule.from)?.type==='date'&&fields.get(rule.to)?.type==='date')};
}

export async function migrateFormCatalog(pool) {
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtext('fit-form-catalog-v1'))");
  await db.query(`
   CREATE TABLE IF NOT EXISTS fit_form_retired_ids (id text PRIMARY KEY);
   CREATE TABLE IF NOT EXISTS fit_form_types (
    id text PRIMARY KEY, position integer NOT NULL, state text NOT NULL CHECK(state IN ('active','inactive','archived')),
    current_version_id bigint, draft jsonb NOT NULL, revision integer NOT NULL DEFAULT 1
   );
   CREATE TABLE IF NOT EXISTS fit_form_versions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, type_id text NOT NULL REFERENCES fit_form_types(id) ON DELETE CASCADE,
    number integer NOT NULL, schema jsonb NOT NULL, published_by text NOT NULL, published_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(type_id,number), UNIQUE(type_id,id)
   );
   DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='fit_form_types'::regclass AND conname='fit_form_types_current_version_fk') THEN
     ALTER TABLE fit_form_types ADD CONSTRAINT fit_form_types_current_version_fk
      FOREIGN KEY (id,current_version_id) REFERENCES fit_form_versions(type_id,id) DEFERRABLE INITIALLY DEFERRED;
    END IF;
   END $$;
   ALTER TABLE fit_requests ADD COLUMN IF NOT EXISTS form_version_id bigint REFERENCES fit_form_versions(id) ON DELETE RESTRICT;
   ALTER TABLE fit_requests_audit ADD COLUMN IF NOT EXISTS form_version_id bigint REFERENCES fit_form_versions(id) ON DELETE RESTRICT;
   CREATE INDEX IF NOT EXISTS fit_requests_form_version_idx ON fit_requests(form_version_id);
   CREATE INDEX IF NOT EXISTS fit_requests_audit_form_version_idx ON fit_requests_audit(form_version_id);
  `);
  for(const [position,id] of legacyKinds.entries()){
   const schema=JSON.stringify(legacySchema(id));
   const inserted=await db.query("INSERT INTO fit_form_types(id,position,state,draft) SELECT $1,$2,'active',$3 WHERE NOT EXISTS (SELECT 1 FROM fit_form_retired_ids WHERE id=$1) ON CONFLICT DO NOTHING",[id,position,schema]);
   if(inserted.rowCount){
    const {rows:[version]}=await db.query("INSERT INTO fit_form_versions(type_id,number,schema,published_by) VALUES($1,1,$2,'migration') RETURNING id",[id,schema]);
    await db.query('UPDATE fit_form_types SET current_version_id=$2 WHERE id=$1',[id,version.id]);
   }
  }
  const legacyType="CASE WHEN r.payload->>'requestKind' IN ('new','update','other') THEN r.payload->>'requestKind' WHEN r.payload->>'pageAction'='new' THEN 'new' ELSE 'other' END";
  await db.query("UPDATE fit_requests r SET form_version_id=v.id FROM fit_form_versions v WHERE v.number=1 AND v.type_id="+legacyType+" AND r.form_version_id IS NULL");
  await db.query("UPDATE fit_requests_audit r SET form_version_id=v.id FROM fit_form_versions v WHERE v.number=1 AND v.type_id="+legacyType+
   " AND r.form_version_id IS NULL AND r.action IN ('create','update','import','delete')");
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error}
 finally{db.release()}
}

const publicVersion=row=>({id:String(row.id),typeId:row.type_id,number:row.number,schema:row.schema});
export async function publicCatalog(db){
 const {rows}=await db.query("SELECT v.* FROM fit_form_types t JOIN fit_form_versions v ON v.id=t.current_version_id WHERE t.state='active' ORDER BY t.position,t.id");
 return rows.map(publicVersion);
}
export async function adminCatalog(db){
 const {rows}=await db.query(`SELECT t.*,COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'id',v.id::text,'number',v.number,'publishedAt',v.published_at,'publishedBy',v.published_by)
  ORDER BY v.number DESC) FROM fit_form_versions v WHERE v.type_id=t.id),'[]') versions
  FROM fit_form_types t ORDER BY t.position,t.id`);
 return rows;
}
export async function readVersion(db,id){
 const {rows:[row]}=await db.query('SELECT * FROM fit_form_versions WHERE id=$1',[id]);
 return row&&publicVersion(row);
}
export async function lockType(db,id){
 const {rows:[row]}=await db.query('SELECT * FROM fit_form_types WHERE id=$1 FOR SHARE',[id]);
 return row;
}
export const versionIdValid=id=>typeof id==='string'&&/^[1-9]\d{0,17}$/.test(id);

export async function manageCatalog(pool,user,body){
 if(user.role!=='admin')throw formError('Нет доступа',403);
 if(!object(body))throw formError('Неверный запрос');
 const {action,id,revision}=body;
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  let row;
  if(action!=='create'){
   ({rows:[row]}=await db.query('SELECT * FROM fit_form_types WHERE id=$1 FOR UPDATE',[id]));
   if(!row)throw formError('Тип не найден',404);
   if(revision!==row.revision)throw formError('Тип изменён в другой вкладке. Обнови список.',409);
  }
  if(action==='create'||action==='copy'){
   const draft=row?{...row.draft,name:row.draft.name.slice(0,110)+' — копия'}:{
    name:string(body.name,120,true),description:'',icon:'file',sections:[{id:'main',name:'',fields:[
     {id:'title',type:'text',label:'Название задачи',required:true,hint:'',max:150,options:[],defaultValue:null}
    ]}],rules:[]
   };
   await db.query("INSERT INTO fit_form_types(id,position,state,draft) VALUES($1,1000,'inactive',$2)",['type-'+randomUUID(),JSON.stringify(draft)]);
  }else if(action==='save'||action==='publish'){
   const draft=cleanSchema(body.schema,row.draft.rules);
   const historical=await db.query('SELECT schema FROM fit_form_versions WHERE type_id=$1',[id]);
   const kinds=new Map(historical.rows.flatMap(version=>allFields(version.schema).map(field=>[field.id,field.type])));
   if(allFields(draft).some(field=>kinds.has(field.id)&&kinds.get(field.id)!==field.type))throw formError('Для смены типа опубликованного поля добавь новое поле');
   if(!Number.isInteger(body.position)||body.position<0||body.position>100000)throw formError('Проверь порядок типа');
   let current=row.current_version_id;
   if(action==='publish'){
    const {rows:[version]}=await db.query(`INSERT INTO fit_form_versions(type_id,number,schema,published_by)
     SELECT $1,COALESCE(MAX(number),0)+1,$2,$3 FROM fit_form_versions WHERE type_id=$1 RETURNING id`,
    [id,JSON.stringify(draft),user.telegram_id]);
    current=version.id;
   }
   await db.query('UPDATE fit_form_types SET draft=$2,position=$3,current_version_id=$4,revision=revision+1 WHERE id=$1',
    [id,JSON.stringify(draft),body.position,current]);
  }else if(action==='restore'){
   if(!versionIdValid(body.versionId))throw formError('Неверная версия');
   const version=await readVersion(db,body.versionId);
   if(version?.typeId!==id)throw formError('Версия не найдена',404);
   await db.query('UPDATE fit_form_types SET draft=$2,revision=revision+1 WHERE id=$1',[id,JSON.stringify(version.schema)]);
  }else if(action==='state'){
   if(!['active','inactive','archived'].includes(body.state)||body.state==='active'&&!row.current_version_id)throw formError('Сначала опубликуй форму');
   await db.query('UPDATE fit_form_types SET state=$2,revision=revision+1 WHERE id=$1',[id,body.state]);
  }else if(action==='delete'){
   const used=await db.query(`SELECT 1 FROM fit_form_versions v WHERE v.type_id=$1 AND
    (EXISTS (SELECT 1 FROM fit_requests r WHERE r.form_version_id=v.id) OR
     EXISTS (SELECT 1 FROM fit_requests_audit a WHERE a.form_version_id=v.id)) LIMIT 1`,[id]);
   if(used.rowCount)throw formError('Для этого типа есть заявки или история. Используй архивирование.',409);
   await db.query('INSERT INTO fit_form_retired_ids(id) VALUES($1)',[id]);
   await db.query('DELETE FROM fit_form_types WHERE id=$1',[id]);
  }else throw formError('Неизвестное действие');
  const result=await adminCatalog(db);
  await db.query('COMMIT');
  return result;
 }catch(error){await db.query('ROLLBACK');throw error}
 finally{db.release()}
}
