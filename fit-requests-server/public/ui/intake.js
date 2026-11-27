import {fieldLabel,requestFields,storedKind} from './request-fields.js';
import {allFields,empty,legacyKinds,legacySchema,printAnswer,validateAnswers,valueError} from './form-schema.js';
import {mountFields,collectAnswers,fieldControlId as control} from './form-render.js';
const modal=document.getElementById('requestDialog');
const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const get=key=>(document.getElementById(control(key))?.value||'').trim();
const put=(key,value)=>{const el=document.getElementById(control(key));if(el)el.value=value||''};
let configuration;
let catalog=[];
let answersByType=new Map();
let opening=false;
let readOnly=false;
const fieldsContainer=()=>document.getElementById('configuredFields');
const currentAnswers=()=>collectAnswers(fieldsContainer());
const icons={file:'▤',star:'★',refresh:'↻',chart:'▥',link:'↗',flag:'⚑'};
const defaults=schema=>Object.fromEntries(allFields(schema).map(field=>[field.id,field.defaultValue]));
async function loadCatalog(){
 const response=await fetch('/api/form-types',{cache:'no-store'});
 if(!response.ok)throw Error('Не удалось загрузить типы заявок');
 return (await response.json()).items;
}
let initialFormState='';
const formState=()=>JSON.stringify([configuration?.id,currentAnswers(),get('project'),get('status')]);
let saving=false;
let operationId;
const discard=document.createElement('dialog');
discard.id='discardRequestDialog';
discard.setAttribute('aria-labelledby','discardRequestTitle');
discard.setAttribute('aria-describedby','discardRequestMessage');
discard.innerHTML=`<form method="dialog">
 <h2 id="discardRequestTitle">Закрыть без сохранения?</h2>
 <p id="discardRequestMessage">Введенные изменения будут потеряны.</p>
 <div class="modal-actions">
  <button class="button secondary" value="continue" autofocus>Продолжить редактирование</button>
  <button class="button primary" value="discard">Закрыть без сохранения</button>
 </div>
</form>`;
modal.after(discard);
discard.addEventListener('close',()=>{
 if(discard.returnValue==='discard')modal.close();
});
function closeIntake(){
 if(saving)return;
 if(formState()===initialFormState){modal.close();return}
 discard.returnValue='';
 discard.showModal();
}
function clearError(key){
 const input=document.getElementById(control(key));
 input?.removeAttribute('aria-invalid');
 const message=document.getElementById(control(key)+'Error');
 if(message){message.hidden=true;message.textContent=''}
}
function showError(message,key){
 const input=key&&document.getElementById(control(key));
 const feedback=input&&!input.disabled&&document.getElementById(control(key)+'Error');
 if(feedback){
  input.setAttribute('aria-invalid','true');feedback.textContent=message;feedback.hidden=false;input.focus();
 }else{
  const general=document.getElementById('intakeError');
  general.textContent=message;general.hidden=false;
 }
}
modal.innerHTML=`<form id="intakeForm" novalidate>
<div class="modal-head"><div><small>FIT REQUESTS</small><h2 id="dialogTitle">Новая заявка</h2><p class="sub">Выбери тип заявки и заполни поля. Незавершенную заявку можно сохранить в черновик.</p></div><div class="intake-header-actions"><button type="button" class="button secondary request-delete" id="deleteIntake" hidden>Удалить</button><button class="close" type="button" id="closeIntake" aria-label="Закрыть">×</button></div></div>
<input type="hidden" id="requestId">
<section class="intake-section"><h3>Тип заявки</h3><div class="request-kind-switch" role="group" aria-label="Тип заявки"></div><p class="sub" id="formTypeDescription" hidden></p><p class="sub">Поля со звездочкой обязательны.</p><div id="configuredFields"></div></section>
<div id="obsoleteAnswers" hidden></div>
<section class="intake-section" id="pmReviewFields" hidden><h3>Обработка заявки PM</h3><label>Проект<select id="requestProject"></select></label><label>Этап обработки<select id="requestStatus"><option>Новая</option><option>Уточнение</option></select></label></section>
<p id="intakeError" role="alert" hidden></p><div class="modal-actions"><button type="button" class="button secondary" id="saveDraft">Сохранить черновик</button><button type="submit" class="button primary" id="submitIntake">Подать заявку</button></div></form>`;
function showConfiguration(next,answers,fixed=false){
 configuration=next;
 const container=modal.querySelector('.request-kind-switch');
 container.replaceChildren();
 for(const option of fixed?[next]:catalog){
  const button=document.createElement('button');
  button.type='button';button.className='mode-button';button.dataset.kind=option.typeId;
  const icon=document.createElement('span');icon.textContent=icons[option.schema.icon]||'';icon.setAttribute('aria-hidden','true');
  button.append(icon,' '+option.schema.name);
  const current=option.typeId===next.typeId;
  button.classList.toggle('active',current);button.setAttribute('aria-pressed',String(current));
  button.disabled=fixed;
  button.onclick=()=>{
   if(current)return;
   const existing=currentAnswers();
   answersByType.set(next.typeId,existing);
   const shared=compatibleAnswers(next.schema,option.schema,existing);
   showConfiguration(option,{...defaults(option.schema),...shared,...answersByType.get(option.typeId)});
  };
  container.append(button);
 }
 const description=document.getElementById('formTypeDescription');
 description.textContent=next.schema.description;description.hidden=!description.textContent;
 mountFields(fieldsContainer(),next.schema,answers);
 fieldsContainer().querySelectorAll('input,select,textarea').forEach(control=>control.disabled=readOnly);
}
function compatibleAnswers(oldSchema,newSchema,answers){
 const oldFields=new Map(allFields(oldSchema).map(field=>[field.id,field]));
 const retained={};
 for(const field of allFields(newSchema)){
  if(!Object.hasOwn(answers,field.id)||oldFields.get(field.id)?.type!==field.type)continue;
  const value=answers[field.id];
  const compatible=field.type==='multi'&&Array.isArray(value)?
   value.filter(id=>field.options.some(option=>option.id===id)):value;
  if(!valueError({...field,required:false},compatible,true))retained[field.id]=compatible;
 }
 return retained;
}
async function refreshChangedForm(){
 const previous=configuration;
 const answers=currentAnswers();
 catalog=await loadCatalog();
 const next=catalog.find(item=>item.typeId===previous.typeId);
 if(!next)throw Error('Этот тип больше недоступен. Скопируй ответы из открытой формы перед закрытием.');
 const retained=compatibleAnswers(previous.schema,next.schema,answers);
 const discarded=allFields(previous.schema).flatMap(field=>{
  const saved=answers[field.id];
  const preserved=retained[field.id];
  const lost=Array.isArray(saved)&&Array.isArray(preserved)?
   saved.filter(value=>!preserved.includes(value)):Object.hasOwn(retained,field.id)?null:saved;
  return empty(lost)?[]:[field.label+': '+printAnswer(field,lost)];
 });
 const obsolete=document.getElementById('obsoleteAnswers');
 if(discarded.length){
  const label=document.createElement('label');
  label.textContent='Ответы из предыдущей версии, которые можно скопировать';
  const copy=document.createElement('textarea');copy.readOnly=true;copy.rows=4;
  copy.value=discarded.join('\n');
  label.append(copy);obsolete.append(label);obsolete.hidden=false;
 }
 answersByType.delete(previous.typeId);
 showConfiguration(next,{...defaults(next.schema),...retained});
 operationId=crypto.randomUUID();
 const oldFields=new Map(allFields(previous.schema).map(field=>[field.id,field]));
 const values=currentAnswers();
 const required=allFields(next.schema).filter(field=>field.required&&!oldFields.get(field.id)?.required&&empty(values[field.id]));
 for(const field of required)showError('Новое обязательное поле',field.id);
 showError('Форма обновилась. Совместимые ответы перенесены. Проверь поля и сохрани ещё раз.');
}
openForm=async function(id){
 if(opening||modal.open)return;
 opening=true;
 try{
  const t=data.find(item=>item.id===id);
  const historical=t?.formVersion||(t?{id:null,typeId:storedKind(t),schema:legacySchema(storedKind(t))}:null);
  if(!historical)catalog=await loadCatalog();
  const next=historical||catalog.find(item=>item.typeId==='other')||catalog[0];
  if(!next){notify('Нет доступных типов заявок');return}
  readOnly=t?.status==='Черновик'&&historical?.state==='archived';
  document.getElementById('intakeForm').reset();put('id',t?.id);
  answersByType=new Map();
  const original=t?.formAnswers||(t?Object.fromEntries(allFields(next.schema).map(({id})=>[id,t[id]??(id==='owner'?t.pageOwner:null)])):defaults(next.schema));
  showConfiguration(next,original,Boolean(t));
  operationId=crypto.randomUUID();
  document.getElementById('intakeError').hidden=true;
  const obsolete=document.getElementById('obsoleteAnswers');obsolete.replaceChildren();obsolete.hidden=true;
  document.getElementById('dialogTitle').textContent=readOnly?'Просмотр черновика':t?'Редактирование заявки':'Новая заявка';
  document.getElementById('requestProject').innerHTML='<option value="">Не определено</option>'+projects.map(p=>'<option value="'+safe(p.id)+'">'+safe(p.name)+'</option>').join('');put('project',t?.project);
  document.getElementById('pmReviewFields').hidden=!(window.FitUser?.role==='admin'&&t&&!readOnly);
  put('status',t?.status==='Уточнение'?'Уточнение':'Новая');
  document.getElementById('saveDraft').hidden=Boolean(readOnly||t&&t.status!=='Черновик');
  const remove=document.getElementById('deleteIntake');remove.hidden=!window.FitRequestPersistence?.canDelete(t);remove.textContent=t?.status==='Черновик'?'Удалить черновик':'Удалить заявку';
  const submit=document.getElementById('submitIntake');
  submit.hidden=Boolean(readOnly);
  submit.textContent=t&&t.status!=='Черновик'?'Сохранить изменения':'Подать заявку';
  if(readOnly)showError('Тип архивирован. Черновик доступен для просмотра.');
  initialFormState=formState();
  modal.showModal();
  if(!readOnly)document.getElementById('requestTitle')?.focus();
 }catch(error){notify(error.message)}
 finally{opening=false}
};
function setSaving(value){
 saving=value;
 modal.setAttribute('aria-busy',String(value));
 for(const id of ['saveDraft','submitIntake','closeIntake','deleteIntake'])document.getElementById(id).disabled=value;
 for(const section of modal.querySelectorAll('.intake-section'))section.inert=value;
}
async function submit(draft){
 if(saving||readOnly)return;
 if(!window.FitUser||!window.FitRequestPersistence){showError('Дождись загрузки профиля и заявок');return}
 const old=data.find(t=>t.id===get('id'));
 const answers=currentAnswers();
 const payload={requestKind:configuration.typeId,formVersionId:configuration.id??undefined,formAnswers:answers};
 document.getElementById('intakeError').hidden=true;
 for(const field of allFields(configuration.schema))clearError(field.id);
 const error=validateAnswers(configuration.schema,answers,draft);
 if(error){showError(error.message,error.key);return}
 if(window.FitUser.role==='admin'&&old)payload.project=get('project');
 payload.status=draft?'Черновик':window.FitUser.role==='admin'&&old?get('status'):'Новая';
 setSaving(true);
 let failure;
 try{
  await window.FitRequestPersistence.submit(old,payload,operationId);
  modal.close();detailId=null;page='requests';render();
  notify(draft?'Черновик сохранён':old&&old.status!=='Черновик'?'Изменения сохранены':'Заявка подана');
 }catch(error){
  failure=error;
 }finally{
  setSaving(false);
 }
 if(failure?.code==='form_changed'&&!old){
  setSaving(true);
  try{await refreshChangedForm()}
  catch(error){showError(error.message)}
  finally{setSaving(false)}
 }else if(failure)showError('Не удалось сохранить. '+failure.message,failure.field);
}
document.getElementById('intakeForm').addEventListener('submit',e=>{e.preventDefault();submit(false)});
modal.addEventListener('input',event=>{
 const key=event.target.closest('[data-field]')?.dataset.field;
 if(key)clearError(key);
});
document.getElementById('saveDraft').onclick=()=>submit(true);
document.getElementById('closeIntake').onclick=closeIntake;
modal.addEventListener('cancel',event=>{event.preventDefault();closeIntake()});
document.getElementById('deleteIntake').onclick=()=>window.FitRequestPersistence?.remove(get('id'));
const originalRender=render;
render=function(){
 originalRender();
 if(!detailId)return;
 const t=data.find(x=>x.id===detailId),root=document.querySelector('#main .detail-layout .stack');if(!t||!root)return;
 const schema=t.formVersion?.schema||legacySchema(storedKind(t));
 const values=t.formAnswers||t;
 const version=t.formVersion;
 const kind=version?.typeId||storedKind(t);
 const keys=new Set(allFields(schema).map(field=>field.id));
 const additional=(!version||version.number===1)&&legacyKinds.includes(kind)?
  requestFields.filter(field=>!keys.has(field[0])&&typeof t[field[0]]==='string'&&t[field[0]]):[];
 const section=document.createElement('section');section.className='panel request-details';
 section.innerHTML='<div class="panel-header"><h2>'+safe(schema.name)+'</h2></div>'+
 schema.sections.map(group=>'<div class="panel-body kv">'+(group.name?'<h3>'+safe(group.name)+'</h3>':'')+
 group.fields.filter(field=>!['title','description'].includes(field.id)).map(field=>
  '<div class="kv-row"><span>'+safe(field.label)+'</span><b>'+safe(printAnswer(field,values[field.id])||'—')+'</b></div>').join('')+'</div>').join('');
 if(additional.length)section.insertAdjacentHTML('beforeend','<div class="panel-body kv"><h3>Сохранённые поля ранней формы</h3>'+
  additional.map(field=>'<div class="kv-row"><span>'+safe(fieldLabel(field,kind))+'</span><b>'+safe(t[field[0]])+'</b></div>').join('')+'</div>');
 root.prepend(section);
};
render();
