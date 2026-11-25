import {requestKinds, requestFields, activeFields, fieldLabel, validateRequestFields} from './request-fields.js';
const modal=document.getElementById('requestDialog');
const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const control=key=>'request'+key[0].toUpperCase()+key.slice(1);
const get=key=>(document.getElementById(control(key))?.value||'').trim();
const put=(key,value)=>{const el=document.getElementById(control(key));if(el)el.value=value||''};
let kind='other';
const hints={express:'Если по проекту есть отдельный чат, добавь ссылку.',counter:'Укажи, нужен ли счетчик и до какой даты. Если не нужен — напиши «Не нужен».',otherPromotions:'Укажи акции для блока или напиши «Не нужен».',desiredDue:'Это пожелание, не срок разработки'};
const fieldMarkup=([key,label,type,kinds,required,max])=>`<label data-field="${key}"><span data-label="${key}">${safe(label)}${required?' *':''}</span>${type==='textarea'?`<textarea id="${control(key)}" rows="3" maxlength="${max}"></textarea>`:`<input id="${control(key)}" type="${type}" maxlength="${max}" ${type==='url'?'placeholder="https://..."':''}>`}${hints[key]?`<small>${hints[key]}</small>`:''}</label>`;
modal.innerHTML=`<form id="intakeForm" novalidate>
<div class="modal-head"><div><small>FIT REQUESTS</small><h2 id="dialogTitle">Новая заявка</h2><p class="sub">Выбери тип заявки и заполни поля. Незавершенную заявку можно сохранить в черновик.</p></div><button class="close" type="button" id="closeIntake" aria-label="Закрыть">×</button></div>
<input type="hidden" id="requestId">
<section class="intake-section"><h3>Тип заявки</h3><div class="request-kind-switch" role="group" aria-label="Тип заявки">${Object.entries(requestKinds).map(([key,label])=>`<button type="button" class="mode-button" data-kind="${key}" aria-pressed="false">${label}</button>`).join('')}</div><p class="sub">Поля со звездочкой обязательны.</p>${requestFields.map(fieldMarkup).join('')}</section>
<section class="intake-section" id="pmReviewFields" hidden><h3>Обработка заявки PM</h3><label>Проект<select id="requestProject"></select></label><label>Этап обработки<select id="requestStatus"><option>Новая</option><option>Уточнение</option></select></label></section>
<div class="modal-actions"><button type="button" class="button secondary request-delete" id="deleteIntake" hidden>Удалить</button><button type="button" class="button secondary" id="cancelIntake">Отмена</button><button type="button" class="button secondary" id="saveDraft">Черновик</button><button type="submit" class="button primary" id="submitIntake">Подать заявку</button></div></form>`;
function syncKind(next){
 kind=Object.hasOwn(requestKinds,next)?next:'other';
 document.querySelectorAll('[data-kind]').forEach(b=>{const active=b.dataset.kind===kind;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active))});
 const visible=new Set(activeFields(kind).map(f=>f[0]));
 for(const field of requestFields){const [key,,,,required]=field,el=document.getElementById(control(key));el.closest('label').hidden=!visible.has(key);el.disabled=!visible.has(key);el.required=visible.has(key)&&required;document.querySelector('[data-label="'+key+'"]').textContent=fieldLabel(field,kind)+(required?' *':'')}
}
openForm=function(id){
 const t=data.find(x=>x.id===id);document.getElementById('intakeForm').reset();put('id',t?.id);
 for(const [key] of requestFields)put(key,t?.[key]);
 put('owner',t?.owner||t?.pageOwner||t?.requester||window.FitUser?.displayName||'');
 syncKind(t?.requestKind||(t?.pageAction==='new'?'new':'other'));
 document.getElementById('dialogTitle').textContent=t?'Редактирование заявки':'Новая заявка';
 document.getElementById('requestProject').innerHTML='<option value="">Не определено</option>'+projects.map(p=>'<option value="'+safe(p.id)+'">'+safe(p.name)+'</option>').join('');put('project',t?.project);
 document.getElementById('pmReviewFields').hidden=!(window.FitUser?.role==='admin'&&t);
 put('status',t?.status==='Уточнение'?'Уточнение':'Новая');
 document.getElementById('saveDraft').hidden=Boolean(t&&t.status!=='Черновик');
 const remove=document.getElementById('deleteIntake');remove.hidden=!window.FitRequestPersistence?.canDelete(t);remove.textContent=t?.status==='Черновик'?'Удалить черновик':'Удалить заявку';
 document.getElementById('submitIntake').textContent=t?'Сохранить изменения':'Подать заявку';
 modal.showModal();document.getElementById('requestTitle').focus();
};
function submit(draft){
 if(!window.FitUser||!window.FitRequestPersistence){notify('Дождись загрузки профиля и заявок');return}
 const old=data.find(t=>t.id===get('id'));
 const payload={requestKind:kind,...Object.fromEntries(activeFields(kind).map(([key])=>[key,get(key)]))};
 const error=validateRequestFields(payload,{draft});if(error){notify(error.message);document.getElementById(control(error.key))?.focus();return}
 const id=old?.id||'REQ-'+(Math.max(100,...data.map(t=>Number(String(t.id).split('-')[1])||0))+1);
 payload.requester=old?.requester||window.FitUser.displayName||window.FitUser.telegramId;
 payload.project=window.FitUser.role==='admin'?get('project'):(old?.project||'');
 payload.mode='employee';payload.updatedAt=new Date().toISOString();
 payload.status=draft?'Черновик':window.FitUser.role==='admin'&&old?get('status'):old?.status&&old.status!=='Черновик'?old.status:'Новая';
 if(old)Object.assign(old,payload);else data.unshift({id,created:iso(new Date()),...payload});
 save();modal.close();detailId=null;page='requests';render();notify('Заявка сохраняется');
}
document.querySelectorAll('[data-kind]').forEach(b=>b.addEventListener('click',()=>syncKind(b.dataset.kind)));
document.getElementById('intakeForm').addEventListener('submit',e=>{e.preventDefault();submit(false)});
document.getElementById('saveDraft').onclick=()=>submit(true);
document.getElementById('cancelIntake').onclick=document.getElementById('closeIntake').onclick=()=>modal.close();
document.getElementById('deleteIntake').onclick=()=>window.FitRequestPersistence?.remove(get('id'));
const originalRender=render;
render=function(){
 originalRender();
 if(!detailId)return;
 const t=data.find(x=>x.id===detailId),root=document.querySelector('#main .detail-layout .stack');if(!t||!root)return;
 const requestKind=Object.hasOwn(requestKinds,t.requestKind)?t.requestKind:'other';
 const section=document.createElement('section');section.className='panel request-details';
 section.innerHTML='<div class="panel-header"><h2>'+safe(requestKinds[requestKind])+'</h2></div><div class="panel-body kv">'+activeFields(requestKind).filter(([key])=>!['title','description'].includes(key)).map(field=>'<div class="kv-row"><span>'+safe(fieldLabel(field,requestKind))+'</span><b>'+safe(t[field[0]]||'—')+'</b></div>').join('')+'</div>';root.prepend(section);
};
render();
