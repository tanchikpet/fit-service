import {requestKinds, requestFields, activeFields, fieldLabel, isRequired, storedKind, validateRequestFields} from './request-fields.js';
const modal=document.getElementById('requestDialog');
const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const control=key=>'request'+key[0].toUpperCase()+key.slice(1);
const get=key=>(document.getElementById(control(key))?.value||'').trim();
const put=(key,value)=>{const el=document.getElementById(control(key));if(el)el.value=value||''};
let kind='other';
let initialFormState='';
const formState=()=>JSON.stringify([kind,...Array.from(modal.querySelectorAll('input,textarea,select'),el=>[el.id,el.value])]);
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
const hints={
 actualUrl:'Если задача касается существующей страницы, добавь ссылку. Если страницы еще нет или ты не знаешь адрес — оставь поле пустым.',
 express:'Ссылка на отдельный чат по проекту, если он есть',
 counter:'Укажи, нужен ли счетчик и до какой даты. Если не нужен — напиши «Не нужен».',
 otherPromotions:'Укажи акции для блока или напиши «Не нужен».',
 desiredDue:'Это пожелание, не срок разработки'
};
function fieldMarkup([key,label,type,,,max]){
 const id=control(key);
 const describedBy=`${id}Error${hints[key]?' '+id+'Hint':''}`;
 const attrs=`id="${id}" maxlength="${max}" aria-describedby="${describedBy}"`;
 return `<div class="intake-field" data-field="${key}">
  <label for="${id}"><span data-label="${key}">${safe(label)}</span></label>
  ${type==='textarea'?`<textarea ${attrs} rows="3"></textarea>`:`<input ${attrs} type="${type}" ${type==='url'?'placeholder="https://..."':''}>`}
  ${hints[key]?`<small id="${id}Hint">${hints[key]}</small>`:''}
  <small class="field-error" id="${id}Error" hidden></small>
 </div>`;
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
<section class="intake-section"><h3>Тип заявки</h3><div class="request-kind-switch" role="group" aria-label="Тип заявки">${Object.entries(requestKinds).map(([key,label])=>`<button type="button" class="mode-button" data-kind="${key}" aria-pressed="false">${label}</button>`).join('')}</div><p class="sub">Поля со звездочкой обязательны.</p>${requestFields.map(fieldMarkup).join('')}</section>
<section class="intake-section" id="pmReviewFields" hidden><h3>Обработка заявки PM</h3><label>Проект<select id="requestProject"></select></label><label>Этап обработки<select id="requestStatus"><option>Новая</option><option>Уточнение</option></select></label></section>
<p id="intakeError" role="alert" hidden></p><div class="modal-actions"><button type="button" class="button secondary" id="saveDraft">Сохранить черновик</button><button type="submit" class="button primary" id="submitIntake">Подать заявку</button></div></form>`;
function syncKind(next){
 kind=Object.hasOwn(requestKinds,next)?next:'other';
 document.querySelectorAll('[data-kind]').forEach(b=>{const active=b.dataset.kind===kind;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active))});
 const visible=new Set(activeFields(kind).map(f=>f[0]));
 for(const field of requestFields){
  const [key]=field,el=document.getElementById(control(key));
  el.closest('[data-field]').hidden=!visible.has(key);
  el.disabled=!visible.has(key);
  el.required=visible.has(key)&&isRequired(field,kind);
  document.querySelector('[data-label="'+key+'"]').textContent=fieldLabel(field,kind)+(el.required?' *':'');
  clearError(key);
 }
 const pageHint=document.getElementById('requestActualUrlHint');
 pageHint.hidden=kind!=='other';
 document.getElementById('requestActualUrl').setAttribute('aria-describedby',
  kind==='other'?'requestActualUrlError requestActualUrlHint':'requestActualUrlError');
}
openForm=function(id){
 const t=data.find(x=>x.id===id);document.getElementById('intakeForm').reset();put('id',t?.id);
 for(const [key] of requestFields)put(key,t?.[key]);
 put('owner',t?.owner??t?.pageOwner);
 syncKind(storedKind(t));
 operationId=crypto.randomUUID();
 document.getElementById('intakeError').hidden=true;
 document.getElementById('dialogTitle').textContent=t?'Редактирование заявки':'Новая заявка';
 document.getElementById('requestProject').innerHTML='<option value="">Не определено</option>'+projects.map(p=>'<option value="'+safe(p.id)+'">'+safe(p.name)+'</option>').join('');put('project',t?.project);
 document.getElementById('pmReviewFields').hidden=!(window.FitUser?.role==='admin'&&t);
 put('status',t?.status==='Уточнение'?'Уточнение':'Новая');
 document.getElementById('saveDraft').hidden=Boolean(t&&t.status!=='Черновик');
 const remove=document.getElementById('deleteIntake');remove.hidden=!window.FitRequestPersistence?.canDelete(t);remove.textContent=t?.status==='Черновик'?'Удалить черновик':'Удалить заявку';
 document.getElementById('submitIntake').textContent=t&&t.status!=='Черновик'?'Сохранить изменения':'Подать заявку';
 initialFormState=formState();
 modal.showModal();document.getElementById('requestTitle').focus();
};
function setSaving(value){
 saving=value;
 modal.setAttribute('aria-busy',String(value));
 for(const id of ['saveDraft','submitIntake','closeIntake','deleteIntake'])document.getElementById(id).disabled=value;
 for(const section of modal.querySelectorAll('.intake-section'))section.inert=value;
}
async function submit(draft){
 if(saving)return;
 if(!window.FitUser||!window.FitRequestPersistence){showError('Дождись загрузки профиля и заявок');return}
 const old=data.find(t=>t.id===get('id'));
 const payload={requestKind:kind,...Object.fromEntries(activeFields(kind).map(([key])=>[key,get(key)]))};
 document.getElementById('intakeError').hidden=true;
 for(const [key] of requestFields)clearError(key);
 const error=validateRequestFields(payload,{draft});
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
 if(failure)showError('Не удалось сохранить. '+failure.message,failure.field);
}
document.querySelectorAll('[data-kind]').forEach(b=>b.addEventListener('click',()=>syncKind(b.dataset.kind)));
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
 const requestKind=storedKind(t);
 const fields=requestFields.filter(field=>activeFields(requestKind).includes(field)||t[field[0]]);
 const section=document.createElement('section');section.className='panel request-details';
 section.innerHTML='<div class="panel-header"><h2>'+safe(requestKinds[requestKind])+'</h2></div><div class="panel-body kv">'+fields.filter(([key])=>!['title','description'].includes(key)).map(field=>'<div class="kv-row"><span>'+safe(fieldLabel(field,requestKind))+'</span><b>'+safe(t[field[0]]||'—')+'</b></div>').join('')+'</div>';root.prepend(section);
};
render();
