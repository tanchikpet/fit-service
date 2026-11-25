"use strict";
(()=>{
const modal=document.getElementById("requestDialog");
const safe=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fields={Title:"title",Project:"project",PageUrl:"pageUrl",Requester:"requester",Department:"department",OnBehalf:"onBehalf",Description:"description",Goal:"goal",Desired:"desiredDue",Materials:"materials",Express:"express",Type:"type",Priority:"priority",Status:"status",Assignee:"assignee",Due:"due",Kaiten:"kaiten",PageAction:"pageAction",PlannedUrl:"plannedUrl",ActualUrl:"actualUrl",PagePurpose:"pagePurpose",PageOwner:"pageOwner",PromotionEnd:"promotionEnd",RedirectTo:"redirectTo"};
const campaignFields=[["Title","title","Название задачи","text","all",true],["Owner","owner","Ответственный","text","all",true],["PlannedUrl","plannedUrl","Планируемый адрес","url","new",true],["PageUrl","pageUrl","Адрес","url","update other",true],["Description","description","Описание задачи","textarea","all",true],["SourceId","sourceId","id источника","text","new",true],["PromoCode","promoCode","Промо-код","text","new",false],["CardRange","cardRange","Диапазон карт","text","new",false],["CampaignId","campaignId","ID кампании в ЗС","text","new",false],["Offer","offer","Оффер","textarea","new update",true],["CampaignStart","campaignStart","Начало акции","date","new update",true],["CampaignEnd","campaignEnd","Окончание акции","date","new update",true],["Stations","stations","Для каких станций","textarea","new",true],["Terms","terms","Условия акции","textarea","new update",true],["Restrictions","restrictions","Ограничения акции","textarea","new update",true],["OtherPromotions","otherPromotions","Блок Другие Акции","textarea","new update",true],["Counter","counter","Счетчик","textarea","new",true],["CampaignGoals","campaignGoals","Цели Акции","textarea","new",true],["Materials","materials","Ссылка на материалы","url","all",false],["Goal","goal","Ожидаемый результат","textarea","all",false],["Desired","desiredDue","Желаемый срок","date","all",false],["Express","express","Чат проекта","url","all",false]];
const actionLabels={new:"Новая акция",update:"Обновление акции",other:"Другое"};
let mode="employee",requestKind="other";
Object.assign(fields,Object.fromEntries(campaignFields.map(([id,key])=>[id,key])));
const fieldMarkup=([id,key,label,type,kinds,required])=>`<label data-request-field="${id}" data-kinds="${kinds}"><span id="label${id}">${safe(label)}${required?" *":""}</span>${type==="textarea"?`<textarea id="request${id}" rows="3"></textarea>`:`<input id="request${id}" type="${type}" ${type==="url"?'placeholder="https://..."':""}>`}${id==="Express"?'<small>Если по проекту есть отдельный чат, добавь ссылку.</small>':id==="Counter"?'<small>Укажи, нужен ли счетчик и до какой даты. Если не нужен — напиши «Не нужен».</small>':id==="OtherPromotions"?'<small>Укажи акции для блока или напиши «Не нужен».</small>':""}</label>`;
modal.innerHTML=`<style>#requestDialog [hidden]{display:none!important}#requestDialog [data-kind]{flex:1;text-align:center}#requestDialog [aria-label="Тип заявки"]{display:flex;flex-wrap:wrap;gap:8px}#requestDialog .kv-row b{white-space:pre-wrap;overflow-wrap:anywhere}</style><form id="intakeForm" novalidate><div class="modal-head"><div><small>FIT REQUESTS · ДЕМО</small><h2 id="dialogTitle">Новая заявка</h2><p class="sub">Данные сохраняются только в этом браузере.</p></div><button class="close" type="button" id="closeIntake" aria-label="Закрыть">×</button></div>
<input type="hidden" id="requestId">
<div class="form-modes"><button type="button" class="mode-button active" data-mode="employee">Подать заявку<small>Запрос сотрудника</small></button><button type="button" class="mode-button" data-mode="pm">Создать задачу PM<small>Техническое планирование</small></button></div>
<section class="intake-section"><h3>Тип заявки</h3>
<div class="form-modes" role="group" aria-label="Тип заявки">${Object.entries(actionLabels).map(([kind,label])=>`<button type="button" class="mode-button" data-kind="${kind}" aria-pressed="false">${label}</button>`).join("")}</div>
<p class="sub">Поля со звездочкой обязательны. Незавершенную заявку можно сохранить в черновик.</p>
${campaignFields.map(fieldMarkup).join("")}</section>
<section class="intake-section" id="pmFields" hidden><h3>02 · Проработка PM</h3><p class="sub">Эти технические поля не заполняет сотрудник.</p>
<div class="form-grid"><label>Проект<select id="requestProject"></select></label><label>Инициатор<input id="requestRequester" maxlength="120" placeholder="Для теста — вымышленное имя"></label><label>Тип задачи<select id="requestType"><option>Доработка</option><option>Новая функциональность</option><option>Исправление ошибки</option><option>Аналитика</option><option>Дизайн</option></select></label>
<label>Приоритет<select id="requestPriority"><option>Средний</option><option>Высокий</option><option>Критический</option><option>Низкий</option></select></label>
<label>Статус<select id="requestStatus"><option>Новая</option><option>Уточнение</option><option>Запланирована</option><option>Разработка</option><option>Тестирование</option><option>Демо</option><option>Готово</option></select></label>
<label>Исполнитель<select id="requestAssignee"><option>Не назначен</option><option>Дмитрий Ершов</option><option>Дмитрий Олейников</option><option>Внутренняя команда</option></select></label>
<label>Согласованный срок<input id="requestDue" type="date"></label><label>Ссылка на Kaiten<input id="requestKaiten" type="url" placeholder="https://rossko.kaiten.ru/..."></label></div></section>
<div class="modal-actions"><button type="button" class="button secondary" id="cancelIntake">Отмена</button><button type="button" class="button secondary" id="saveDraft">Черновик</button><button type="submit" class="button primary" id="submitIntake">Отправить заявку</button></div></form>`;
function syncKind(kind){
requestKind=Object.hasOwn(actionLabels,kind)?kind:"other";
document.querySelectorAll("[data-kind]").forEach(b=>{const active=b.dataset.kind===requestKind;b.classList.toggle("active",active);b.setAttribute("aria-pressed",String(active))});
campaignFields.forEach(([id,key,label,type,kinds,required])=>{const visible=kinds==="all"||kinds.split(" ").includes(requestKind),el=document.getElementById("request"+id);el.closest("label").hidden=!visible;el.disabled=!visible;el.required=visible&&required});
document.getElementById("labelPageUrl").textContent=(requestKind==="other"?"Ссылка на сайт или страницу":"Адрес")+" *";
}
document.querySelectorAll("[data-kind]").forEach(b=>b.addEventListener("click",()=>syncKind(b.dataset.kind)));
const get=k=>(document.getElementById("request"+k)?.value||"").trim();
const put=(k,v)=>{const el=document.getElementById("request"+k);if(el)el.value=v||""};
const switchMode=m=>{mode=m==="pm"?"pm":"employee";document.getElementById("pmFields").hidden=mode!=="pm";document.querySelectorAll("[data-pm-only]").forEach(el=>el.hidden=mode!=="pm");document.getElementById("submitIntake").textContent=mode==="pm"?"Сохранить задачу":"Отправить заявку";document.querySelectorAll("[data-mode]").forEach(b=>b.classList.toggle("active",b.dataset.mode===mode))};
function intakeOpen(id,requested){const t=data.find(x=>x.id===id);document.getElementById("intakeForm").reset();put("Id",t?.id);document.getElementById("dialogTitle").textContent=t?"Редактирование":requested==="pm"?"Новая задача PM":"Новая заявка";
document.getElementById("requestProject").innerHTML='<option value="">Не определено</option>'+projects.map(p=>'<option value="'+safe(p.id)+'">'+safe(p.name)+'</option>').join("");
Object.entries(fields).forEach(([control,key])=>put(control,t?.[key]));
if(!t){put("Type","Доработка");put("Priority","Средний");put("Status","Новая");put("Assignee","Не назначен")}
put("Owner",t?.owner||t?.pageOwner||"");put("PageUrl",t?.pageUrl||t?.actualUrl||"");syncKind(t?.requestKind||(t?.pageAction==="new"?"new":"other"));if(t?.status==="Черновик")put("Status","Новая");switchMode(requested||t?.mode||"employee");modal.showModal();document.getElementById("requestTitle").focus()}
function urlOkay(k){const v=get(k);if(!v)return true;try{return ["http:","https:"].includes(new URL(v).protocol)}catch{return false}}
function storeRequest(draft){
const activeFields=campaignFields.filter(([, , , ,kinds])=>kinds==="all"||kinds.split(" ").includes(requestKind));
if(!draft){const missing=activeFields.find(([id,,,,,required])=>required&&!get(id));if(missing){notify("Заполни поле «"+(missing[0]==="PageUrl"&&requestKind==="other"?"Ссылка на сайт или страницу":missing[2])+"»");document.getElementById("request"+missing[0]).focus();return}}
const badUrl=activeFields.find(([id,,,type])=>type==="url"&&!urlOkay(id));
if(badUrl||mode==="pm"&&!urlOkay("Kaiten")){notify("Ссылки должны начинаться с https:// или http://");document.getElementById("request"+(badUrl?.[0]||"Kaiten")).focus();return}
if(requestKind!=="other"&&get("CampaignStart")&&get("CampaignEnd")&&get("CampaignEnd")<get("CampaignStart")){notify("Окончание акции не может быть раньше ее начала");document.getElementById("requestCampaignEnd").focus();return}
const old=data.find(t=>t.id===get("Id"));const newId="REQ-"+(Math.max(100,...data.map(t=>Number(String(t.id).split("-")[1])||0))+1);
const base=old||{id:newId,created:iso(new Date()),start:iso(new Date()),type:"Не определён",priority:"Не назначен",status:"Новая",assignee:"Не назначен",due:"",kaiten:""};
const v={requestKind,project:mode==="pm"?get("Project"):(old?.project||""),mode,updatedAt:new Date().toISOString()};
activeFields.forEach(([id,key])=>v[key]=get(id));
if(mode==="pm")v.requester=get("Requester");

if(mode==="pm")Object.assign(v,{type:get("Type"),priority:get("Priority"),status:get("Status"),assignee:get("Assignee"),due:get("Due"),kaiten:get("Kaiten")});
if(draft)v.status="Черновик";else if(base.status==="Черновик"&&mode==="employee")v.status="Новая";
if(old)Object.assign(old,v);else data.unshift({...base,...v});
save();modal.close();detailId=null;page="requests";render();notify(draft?"Черновик сохранён":old?"Изменения сохранены":"Заявка создана");}
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
if(detailId){const t=data.find(x=>x.id===detailId),left=document.querySelector("#main .detail-layout .stack");if(t&&left){const box=document.createElement("section");box.className="panel";const kind=t.requestKind||(t.pageAction==="new"?"new":"other");const props=[["Тип заявки",actionLabels[kind]],...campaignFields.filter(([,key,,type,kinds])=>type!=="url"&&key!=="title"&&key!=="description"&&(kinds==="all"||kinds.split(" ").includes(kind))).map(([,key,label])=>[label,t[key]]),["Инициатор",t.requester]];box.innerHTML='<div class="panel-header"><h2>Исходный запрос</h2></div><div class="panel-body kv">'+props.map(([k,v])=>'<div class="kv-row"><span>'+safe(k)+'</span><b>'+safe(v||"—")+'</b></div>').join("")+'</div>';const body=box.querySelector(".panel-body");for(const [name,val] of [["Ссылка на сайт или страницу",kind==="new"?t.plannedUrl:t.pageUrl],["Материалы",t.materials],["Чат проекта",t.express]]){try{const u=new URL(val);if(["https:","http:"].includes(u.protocol)){const a=document.createElement("a");a.textContent=name+" ↗";a.href=u.href;a.target="_blank";a.rel="noopener noreferrer";a.className="button secondary sm";body.append(a)}}catch{}}
left.insertBefore(box,left.children[1]||null)}}};
document.addEventListener("click",e=>{const b=e.target.closest('[data-action="newpm"]');if(b){e.stopPropagation();e.preventDefault();intakeOpen(null,"pm")}},true);
render();
})();
