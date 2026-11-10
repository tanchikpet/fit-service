"use strict";
(()=>{
const modal=document.getElementById("requestDialog");
const safe=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const mappings={Title:"title",Project:"project",Requester:"requester",Department:"department",OnBehalf:"onBehalf",Description:"description",Goal:"goal",Desired:"desiredDue",Materials:"materials",Express:"express",PageAction:"pageAction",PlannedUrl:"plannedUrl",ActualUrl:"actualUrl",PagePurpose:"pagePurpose",PageOwner:"pageOwner",PromotionEnd:"promotionEnd",RedirectTo:"redirectTo"};
modal.innerHTML='<form id="intakeForm" novalidate>'+
'<div class="modal-head"><div><small>FIT REQUESTS</small><h2 id="dialogTitle">Подать заявку</h2><p class="sub">Опиши потребность. После уточнения PM направит заявку в Kaiten.</p></div><button class="close" type="button" id="closeIntake" aria-label="Закрыть">×</button></div>'+
'<input type="hidden" id="requestId">'+
'<section class="intake-section"><h3>Запрос сотрудника</h3>'+
'<label>Что нужно сделать? *<input id="requestTitle" maxlength="150" placeholder="Например, исправить форму записи"></label>'+
'<div class="form-grid"><label>Где нужны изменения?<select id="requestProject"></select></label><label>Инициатор *<input id="requestRequester" maxlength="120" placeholder="ФИО инициатора"></label></div>'+
'<div class="form-grid"><label>Подразделение<input id="requestDepartment" maxlength="100" placeholder="Например, маркетинг"></label><label>От имени другого сотрудника<input id="requestOnBehalf" maxlength="120" placeholder="При необходимости"></label></div>'+
'<label>Описание потребности *<textarea id="requestDescription" rows="4" placeholder="Что требуется изменить и почему?"></textarea></label>'+
'<label>Ожидаемый результат<textarea id="requestGoal" rows="2" placeholder="Какой результат нужен?"></textarea></label>'+
'<div class="form-grid"><label>Желаемый срок<small>Это пожелание, не срок разработки</small><input id="requestDesired" type="date"></label><label>Ссылка на материалы<input id="requestMaterials" type="url" placeholder="https://..."></label></div>'+
'<label>Обсуждение в Express<input id="requestExpress" type="url" placeholder="https://..."></label></section>'+
'<section class="intake-section"><h3>Страница сайта (если применимо)</h3>'+
'<label>Действие<select id="requestPageAction"><option value="">Не относится к страницам</option><option value="new">Новая страница</option><option value="close">Закрытие страницы</option></select></label>'+
'<div id="pageRequestFields" hidden><div class="form-grid"><label>Планируемый адрес<input id="requestPlannedUrl" type="url" placeholder="https://..."></label><label>Фактический адрес<input id="requestActualUrl" type="url" placeholder="Заполнить после запуска"></label></div>'+
'<label>Назначение страницы<textarea id="requestPagePurpose" rows="2"></textarea></label>'+
'<div class="form-grid"><label>Ответственный за страницу<input id="requestPageOwner" maxlength="120"></label><label>Акция действует до<input id="requestPromotionEnd" type="date"></label></div>'+
'<label id="redirectLabel" hidden>Куда направлять после закрытия<input id="requestRedirectTo" type="url" placeholder="https://..."></label></div></section>'+
'<section class="intake-section" id="pmReviewFields" hidden><h3>Обработка заявки PM</h3>'+
'<p class="sub">Это статус обработки запроса, а не статус разработки в Kaiten.</p>'+
'<label>Этап обработки<select id="requestStatus"><option value="Новая">Новая</option><option value="Уточнение">Уточнение</option></select></label>'+
'</section>'+
'<div class="modal-actions"><button type="button" class="button secondary" id="cancelIntake">Отмена</button><button type="button" class="button secondary" id="saveDraft">Черновик</button><button type="submit" class="button primary" id="submitIntake">Подать заявку</button></div></form>';
const get=k=>(document.getElementById("request"+k)?.value||"").trim();
const put=(k,v)=>{const el=document.getElementById("request"+k);if(el)el.value=v||""};
function syncPageFields(){
 const action=get("PageAction");document.getElementById("pageRequestFields").hidden=!action;
 document.getElementById("redirectLabel").hidden=action!=="close";
}
document.getElementById("requestPageAction").addEventListener("change",syncPageFields);
function intakeOpen(id){
 const t=data.find(x=>x.id===id),form=document.getElementById("intakeForm");
 form.reset();put("Id",t?.id);
 document.getElementById("dialogTitle").textContent=t?"Редактирование заявки":"Подать заявку";
 document.getElementById("requestProject").innerHTML='<option value="">Не определено</option>'+projects.map(p=>'<option value="'+safe(p.id)+'">'+safe(p.name)+'</option>').join("");
 for(const [control,key] of Object.entries(mappings))put(control,t?.[key]);
 const isPm=window.FitUser?.role==="admin";
 const pmArea=document.getElementById("pmReviewFields");
 pmArea.hidden=!(isPm&&t);
 if(isPm&&t)put("Status",["Уточнение"].includes(t.status)?t.status:"Новая");
 document.getElementById("saveDraft").hidden=Boolean(t&&t.status!=="Черновик");
 document.getElementById("submitIntake").textContent=t?"Сохранить изменения":"Подать заявку";
 syncPageFields();modal.showModal();document.getElementById("requestTitle").focus();
}
function validUrl(k){
 const v=get(k);if(!v)return true;
 try{const u=new URL(v);return ["https:","http:"].includes(u.protocol)&&!u.username&&!u.password}catch{return false}
}
function submit(draft){
 const old=data.find(t=>t.id===get("Id"));
 const title=get("Title"),description=get("Description"),requester=get("Requester");
 if(!draft&&(!title||!description||!requester)){
  notify("Для подачи нужны название, инициатор и описание");
  document.getElementById(!title?"requestTitle":!requester?"requestRequester":"requestDescription").focus();return
 }
 for(const key of ["Materials","Express","PlannedUrl","ActualUrl","RedirectTo"]){
  if(!validUrl(key)){notify("Проверь адрес в поле "+key+": нужна ссылка http:// или https://");return}
 }
 if(!draft&&get("PageAction")){
  if(!get("Project")||!get("PagePurpose")||!get("PageOwner")||(!get("PlannedUrl")&&!get("ActualUrl"))||(get("PageAction")==="close"&&!get("RedirectTo"))){
   notify("Для страницы укажи проект, назначение, ответственного, адрес и при закрытии — редирект");return
  }
 }
 const id=old?.id||"REQ-"+(Math.max(100,...data.map(t=>Number(String(t.id).split("-")[1])||0))+1);
 const payload={...Object.fromEntries(Object.entries(mappings).map(([key,value])=>[value,get(key)])),
  mode:"employee",updatedAt:new Date().toISOString()};
 // Never duplicate development task status, owner, priority or schedule from Kaiten.
 const priorStatus=old?.status||"Новая";
 const isPm=window.FitUser?.role==="admin";
 payload.status=draft?"Черновик":(isPm&&old?get("Status"):priorStatus==="Черновик"?"Новая":priorStatus);
 if(old)Object.assign(old,payload);
 else data.unshift({id,created:iso(new Date()),start:iso(new Date()),...payload});
 save();modal.close();detailId=null;page="requests";render();
 notify(draft?"Черновик сохраняется":old?"Изменения сохраняются":"Заявка сохраняется");
}
document.getElementById("intakeForm").addEventListener("submit",e=>{e.preventDefault();submit(false)});
document.getElementById("saveDraft").addEventListener("click",()=>submit(true));
document.getElementById("closeIntake").addEventListener("click",()=>modal.close());
document.getElementById("cancelIntake").addEventListener("click",()=>modal.close());
openForm=intakeOpen;
const originalRender=render;
render=function(){
 originalRender();
 document.querySelectorAll('[data-action="new"]').forEach(b=>b.textContent="＋ Подать заявку");
};
render();
})();
