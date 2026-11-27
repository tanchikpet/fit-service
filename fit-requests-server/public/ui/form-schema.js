import {activeFields, fieldLabel, isRequired, requestKinds} from './request-fields.js';

export const legacyKinds = Object.keys(requestKinds);
export const fieldTypes = ['text','textarea','number','date','url','select','multi','boolean'];
const hints = {
 actualUrl:'Если задача касается существующей страницы, добавь ссылку. Если страницы еще нет или ты не знаешь адрес — оставь поле пустым.',
 express:'Ссылка на отдельный чат по проекту, если он есть',
 counter:'Укажи, нужен ли счетчик и до какой даты. Если не нужен — напиши «Не нужен».',
 otherPromotions:'Укажи акции для блока или напиши «Не нужен».',
 desiredDue:'Это пожелание, не срок разработки'
};
export function legacySchema(kind) {
 return {name:requestKinds[kind],description:'',icon:{new:'star',update:'refresh',other:'file'}[kind],
  sections:[{id:'main',name:'',fields:activeFields(kind).map(field=>{
   const [id,,type,,,max]=field;
   return {id,type,max,label:fieldLabel(field,kind),required:isRequired(field,kind),
    hint:id==='actualUrl'&&kind!=='other'?'':hints[id]||'',options:[],defaultValue:null};
  })}],rules:kind==='other'?[]:[{type:'dateOrder',from:'campaignStart',to:'campaignEnd'}]};
}
export const allFields = schema => schema.sections.flatMap(section=>section.fields);
export const empty = value => value==null||value===''||Array.isArray(value)&&!value.length;
export function valueError(field,value,draft=false) {
 if(empty(value))return field.required&&!draft?'Заполни поле «'+field.label+'»':null;
 const bad='Проверь поле «'+field.label+'»';
 const {type,options=[]}=field;
 if(type==='boolean')return typeof value==='boolean'?null:bad;
 if(type==='number')return typeof value==='number'&&Number.isFinite(value)?null:bad;
 if(type==='multi')return Array.isArray(value)&&new Set(value).size===value.length&&value.every(v=>options.some(o=>o.id===v))?null:bad;
 if(typeof value!=='string'||value.length>(field.max||2048))return bad;
 if(!draft&&field.required&&!value.trim())return bad;
 if(type==='select')return options.some(o=>o.id===value)?null:bad;
 if(type==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))return bad;
 if(type==='url'&&!draft){
  try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return bad}catch{return bad}
 }
 return null;
}
export function validateAnswers(schema,answers,draft=false) {
 for(const field of allFields(schema)){
  const message=valueError(field,answers[field.id],draft);
  if(message)return {key:field.id,message};
 }
 if(!draft){
  for(const rule of schema.rules||[]){
   if(rule.type==='dateOrder'&&answers[rule.from]&&answers[rule.to]&&answers[rule.from]>answers[rule.to]){
    return {key:rule.to,message:'Окончание акции не может быть раньше ее начала'};
   }
  }
 }
 return null;
}
export function printAnswer(field,value) {
 if(empty(value))return '';
 if(field.type==='boolean')return value?'Да':'Нет';
 if(field.type==='select'||field.type==='multi'){
  return (Array.isArray(value)?value:[value]).map(id=>field.options.find(option=>option.id===id)?.label||id).join(', ');
 }
 return String(value);
}
