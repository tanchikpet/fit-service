"use strict";
(()=>{
const modal=document.getElementById("requestDialog");
const safe=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fields={Title:"title",Project:"project",Requester:"requester",Department:"department",OnBehalf:"onBehalf",Description:"description",Goal:"goal",Desired:"desiredDue",Materials:"materials",Express:"express",Type:"type",Priority:"priority",Status:"status",Assignee:"assignee",Due:"due",Kaiten:"kaiten",PageAction:"pageAction",PlannedUrl:"plannedUrl",ActualUrl:"actualUrl",PagePurpose:"pagePurpose",PageOwner:"pageOwner",PromotionEnd:"promotionEnd",RedirectTo:"redirectTo"};
let mode="employee";
modal.innerHTML=`<form id="intakeForm" novalidate><div class="modal-head"><div><small>FIT REQUESTS</small><h2 id="dialogTitle">Новая заявка</h2><p class="sub">Заявки сохраняются на защищенном сервере FIT Requests.</p></div><button class="close" type="button" id="closeIntake" aria-label="Закрыть">×</button></div>
<input type="hidden" id="requestId">
<div class="form-modes"><button type="button" class="mode-button active" data-mode="employee">Подать заявку<small>Запрос сотрудника</small></button><button type="button" class="mode-button" data-mode="pm">Создать задачу PM<small>Техническое планирование</small></button></div>
<section class="intake-section"><h3>01 · Исходный запрос</h3>
<label>Что нужно сделать? *<input id="requestTitle" maxlength="150" placeholder="Например, заменить значки на карте"></label>
<div class="form-grid"><label>Где нужны изменения?<select id="requestProject"></select></label><label>Инициатор *<input id="requestRequester" maxlength="120" placeholder="ФИО инициатора"></label></div>
<div class="form-grid"><label>Подразделение<input id="requestDepartment" maxlength="100" placeholder="Например, маркетинг"></label><label>От имени другого сотрудника<input id="requestOnBehalf" maxlength="120" placeholder="Если применимо"></label></div>
<label>Описание потребности *<textarea id="requestDescription" rows="4" placeholder="Что сейчас не устраивает и что требуется изменить?"></textarea></label>
<label>Ожидаемый результат<textarea id="requestGoal" rows="2" placeholder="Как поймём, что задача решена?"></textarea></label>
<div class="form-grid"><label>Желаемый срок<small>Не согласованный срок</small><input id="requestDesired" type="date"></label><label>Ссылка на материалы<input id="requestMaterials" type="url" placeholder="https://..."></label></div>
<label>Ссылка на обсуждение в Express<input id="requestExpress" type="url" placeholder="https://..."></label></section>
<section class="intake-section"><h3>Страница сайта</h3><label>Действие<select id="requestPageAction"><option value="">Не относится к страницам</option><option value="new">Новая страница</option><option value="close">Закрытие страницы</option></select></label><div id="pageRequestFields" hidden><div class="form-grid"><label>Планируемый адрес<input id="requestPlannedUrl" type="url" placeholder="https://…"></label><label>Фактический адрес<input id="requestActualUrl" type="url" placeholder="Заполнить после запуска"></label></div><label>Назначение страницы<textarea id="requestPagePurpose" rows="2"></textarea></label><div class="form-grid"><label>Ответственный за страницу<input id="requestPageOwner" maxlength="150"></label><label>Акция действует до<input id="requestPromotionEnd" type="date"></label></div><label id="redirectLabel" hidden>Куда настроить редирект при закрытии<input id="requestRedirectTo" type="url" placeholder="https://…"></label><p class="sub">Проект выбирается в поле «Где нужны изменения?». Поля страницы можно сохранить в GitHub. После статуса «Готово» доступен перенос в реестр.</p></div></section>
<section class="intake-section" id="pmFields" hidden><h3>02 · Проработка PM</h3><p class="sub">Эти технические поля не заполняет сотрудник.</p>
<div class="form-grid"><label>Тип задачи<select id="requestType"><option>Доработка</option><option>Новая функциональность</option><option>Исправление ошибки</option><option>Аналитика</option><option>Дизайн</option></select></label>
<label>Приоритет<select id="requestPriority"><option>Средний</option><option>Высокий</option><option>Критический</option><option>Низкий</option></select></label>
<label>Статус<select id="requestStatus"><option>Новая</option><option>Уточнение</option><option>Запланирована</option><option>Разработка</option><option>Тестирование</option><option>Демо</option><option>Готово</option></select></label>
<label>Исполнитель<select id="requestAssignee"><option>Не назначен</option><option>Дмитрий Ершов</option><option>Дмитрий Олейников</option><option>Внутренняя команда</option></select></label>
<label>Согласованный срок<input id="requestDue" type="date"></label><label>Ссылка на Kaiten<input id="requestKaiten" type="url" placeholder="https://rossko.kaiten.ru/..."></label></div></section>
<div class="modal-actions"><button type="button" class="button secondary" id="cancelIntake">Отмена</button><button type="button" class="button secondary" id="saveDraft">Черновик</button><button type="submit" class="button primary" id="submitIntake">Отправить заявку</button></div></form>`;
function syncPageFields(){const a=document.getElementById("requestPageAction").value;document.getElementById("pageRequestFields").hidden=!a;document.getElementById("redirectLabel").hidden=a!=="close"}
document.getElementById("requestPageAction").addEventListener("change",syncPageFields);
const get=k=>(document.getElementById("request"+k)?.value||"").trim();
const put=(k,v)=>{const el=document.getElementById("request"+k);if(el)el.value=v||""};
const switchMode=m=>{mode=m==="pm"?"pm":"employee";document.getElementById("pmFields").hidden=mode!=="pm";document.getElementById("submitIntake").textContent=mode==="pm"?"Сохранить задачу":"Отправить заявку";document.querySelectorAll("[data-mode]").forEach(b=>b.classList.toggle("active",b.dataset.mode===mode))};
function intakeOpen(id,requested){const t=data.find(x=>x.id===id);document.getElementById("intakeForm").reset();put("Id",t?.id);document.getElementById("dialogTitle").textContent=t?"Редактирование":requested==="pm"?"Новая задача PM":"Новая заявка";
document.getElementById("requestProject").innerHTML='<option value="">Не определено</option>'+projects.map(p=>'<option value="'+safe(p.id)+'">'+safe(p.name)+'</option>').join("");
Object.entries(fields).forEach(([control,key])=>put(control,t?.[key]));
if(!t){put("Type","Доработка");put("Priority","Средний");put("Status","Новая");put("Assignee","Не назначен")}
syncPageFields();if(t?.status==="Черновик")put("Status","Новая");switchMode(requested||t?.mode||"employee");modal.showModal();document.getElementById("requestTitle").focus()}
function urlOkay(k){const v=get(k);if(!v)return true;try{return ["http:","https:"].includes(new URL(v).protocol)}catch{return false}}
function storeRequest(draft){const title=get("Title"),description=get("Description"),requester=get("Requester");if(!draft&&(!title||(mode!=="pm"&&(!description||!requester)))){notify("Для подачи нужны название, инициатор и описание");document.getElementById(!title?"requestTitle":!requester?"requestRequester":"requestDescription").focus();return}
if(!["Materials","Express",...(mode==="pm"?["Kaiten"]:[])].every(urlOkay)){notify("Ссылки должны начинаться с https:// или http://");return}
if(!draft&&get("PageAction")){if(!get("Project")||!get("PagePurpose")||!get("PageOwner")){notify("Для страницы заполни проект, назначение и ответственного");return}if(!get("PlannedUrl")&&!get("ActualUrl")){notify("Укажи планируемый или фактический адрес");return}if(!["PlannedUrl","ActualUrl","RedirectTo"].every(urlOkay)){notify("Укажи корректные адреса http:// или https://");return}if(get("PageAction")==="close"&&!get("RedirectTo")){notify("Для закрытия укажи адрес редиректа");return}}
const old=data.find(t=>t.id===get("Id"));const newId="REQ-"+(Math.max(100,...data.map(t=>Number(String(t.id).split("-")[1])||0))+1);
const base=old||{id:newId,created:iso(new Date()),start:iso(new Date()),type:"Не определён",priority:"Не назначен",status:"Новая",assignee:"Не назначен",due:"",kaiten:""};
const v={pageAction:get("PageAction"),plannedUrl:get("PlannedUrl"),actualUrl:get("ActualUrl"),pagePurpose:get("PagePurpose"),pageOwner:get("PageOwner"),promotionEnd:get("PromotionEnd"),redirectTo:get("RedirectTo"),title,project:get("Project"),description,requester,department:get("Department"),onBehalf:get("OnBehalf"),goal:get("Goal"),desiredDue:get("Desired"),materials:get("Materials"),express:get("Express"),mode,updatedAt:new Date().toISOString()};
if(mode==="pm")Object.assign(v,{type:get("Type"),priority:get("Priority"),status:get("Status"),assignee:get("Assignee"),due:get("Due"),kaiten:get("Kaiten")});
if(draft)v.status="Черновик";else if(base.status==="Черновик"&&mode==="employee")v.status="Новая";
if(old)Object.assign(old,v);else data.unshift({...base,...v});
save();modal.close();detailId=null;page="requests";render();notify(draft?"Черновик сохранён":old?"Изменения сохранены":"Заявка создана");if(!draft&&v.pageAction)window.FitPageRequests?.persist(data.find(t=>t.id===(old?.id||newId)))}
document.getElementById("intakeForm").addEventListener("submit",e=>{e.preventDefault();storeRequest(false)});
document.getElementById("saveDraft").addEventListener("click",()=>storeRequest(true));
document.getElementById("closeIntake").addEventListener("click",()=>modal.close());
document.getElementById("cancelIntake").addEventListener("click",()=>modal.close());
document.querySelectorAll("[data-mode]").forEach(b=>b.addEventListener("click",()=>switchMode(b.dataset.mode)));
openForm=intakeOpen;
const previousRender=render;
render=function(){previousRender();
document.querySelectorAll('[data-action="new"]').forEach(b=>b.textContent="＋ Подать заявку");
const head=document.querySelector("#main .page-head");if(!detailId&&["overview","requests"].includes(page)&&head&&!head.querySelector('[data-action="newpm"]')){const b=document.createElement("button");b.className="button secondary";b.textContent="＋ Задача PM";b.dataset.action="newpm";head.append(b)}
const status=document.getElementById("statusFilter");if(status&&!Array.from(status.options).some(o=>o.value==="Черновик")){const o=document.createElement("option");o.textContent="Черновик";o.value="Черновик";status.add(o,1)}
if(detailId){const t=data.find(x=>x.id===detailId),left=document.querySelector("#main .detail-layout .stack");if(t&&left){const box=document.createElement("section");box.className="panel";const props=[["Инициатор",t.requester],["Подразделение",t.department],["От имени",t.onBehalf],["Желаемый срок",t.desiredDue],["Ожидаемый результат",t.goal]];box.innerHTML='<div class="panel-header"><h2>Исходный запрос</h2></div><div class="panel-body kv">'+props.map(([k,v])=>'<div class="kv-row"><span>'+safe(k)+'</span><b>'+safe(v||"—")+'</b></div>').join("")+'</div>';const body=box.querySelector(".panel-body");for(const [name,val] of [["Материалы",t.materials],["Обсуждение Express",t.express]]){try{const u=new URL(val);if(["https:","http:"].includes(u.protocol)){const a=document.createElement("a");a.textContent=name+" ↗";a.href=u.href;a.target="_blank";a.rel="noopener noreferrer";a.className="button secondary sm";body.append(a)}}catch{}}
left.insertBefore(box,left.children[1]||null)}}};
document.addEventListener("click",e=>{const b=e.target.closest('[data-action="newpm"]');if(b){e.stopPropagation();e.preventDefault();intakeOpen(null,"pm")}},true);
render();
})();
