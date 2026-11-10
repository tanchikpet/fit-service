"use strict";
const STORE="fit-requests-production";
const projects=[{id:"site",name:"Основной сайт",description:"Основной сайт, запись на СТО, UX и технические улучшения",letter:"FS"},{id:"fleet",name:"FIT FLEET",description:"Корпоративное направление, личный кабинет и B2B-сценарии",letter:"FF"},{id:"landing",name:"Промо-лендинги",description:"Акционные и партнёрские страницы FIT SERVICE",letter:"LP"},{id:"mobile",name:"Мобильные проекты",description:"Клиентские сценарии и взаимодействие с приложением",letter:"MB"},{id:"analytics",name:"Аналитика",description:"События, измерения и отчётность",letter:"AN"}];
const todayLocal=new Date(); const iso=(d)=>{const z=new Date(d);return [z.getFullYear(),String(z.getMonth()+1).padStart(2,"0"),String(z.getDate()).padStart(2,"0")].join("-")};const plus=(days)=>{const z=new Date();z.setDate(z.getDate()+days);return iso(z)};let data=[];
let page="requests",detailId=null,searchTerm="",filterStatus="",filterProject="";
const $=(s)=>document.querySelector(s);const esc=(s)=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));const save=()=>{if(!window.FitRequestPersistence) return notify("Серверное сохранение еще не подключено");window.FitRequestPersistence.save(data.map(t=>({...t})))};const notify=(m)=>{const e=$("#toast");e.textContent=m;e.classList.add("visible");clearTimeout(notify.t);notify.t=setTimeout(()=>e.classList.remove("visible"),3000)};const label=(p)=>projects.find(x=>x.id===p)?.name||p;const fmt=(d)=>d?new Date(d+"T12:00:00").toLocaleDateString("ru-RU",{day:"numeric",month:"short"}):"—";const longdate=(d)=>d?new Date(d+"T12:00:00").toLocaleDateString("ru-RU",{day:"numeric",month:"long",year:"numeric"}):"—";const statusClass=(s)=>({"Разработка":"status-development","Тестирование":"status-testing","Демо":"status-demo","Готово":"status-done"}[s]||"status-new");const badge=(s)=>'<span class="pill '+statusClass(s)+'">'+esc(s)+'</span>';const priority=(s)=>'<span class="'+(["Критический","Высокий"].includes(s)?"priority-high":"priority-normal")+'">● '+esc(s)+'</span>';
const nav=[["requests","☷","Заявки"]];
const heading=(ey,title,desc,action=true)=>'<div class="page-head"><div><div class="eyebrow">'+ey+'</div><h1>'+title+'</h1><p class="sub">'+desc+'</p></div>'+(action?'<button class="button primary" data-action="new">＋ Подать заявку</button>':"")+'</div>';
const stage=t=>t.kaitenParent?"Передана в Kaiten":t.status||"Новая";
const taskTable=(rows,limit)=>{
 const list=limit?rows.slice(0,limit):rows;
 return '<div class="table-wrap"><table><thead><tr><th>ЗАЯВКА</th><th>ПРОЕКТ</th><th>ЭТАП ОБРАБОТКИ</th><th>ИНИЦИАТОР</th><th>СОЗДАНА</th></tr></thead><tbody>'+
 list.map(t=>'<tr data-id="'+esc(t.id)+'"><td><div class="task-title">'+esc(t.title)+'</div><span class="task-key">'+esc(t.id)+'</span></td><td>'+esc(label(t.project))+'</td><td>'+badge(stage(t))+'</td><td>'+esc(t.requester||"—")+'</td><td>'+fmt(t.created)+'</td></tr>').join("")+
 '</tbody></table>'+(list.length?"":'<div class="empty">Заявок по этим условиям не найдено</div>')+'</div>';
};
const requests=()=>{
 const counts=[{name:"Всего заявок",stage:"",count:data.length},
 {name:"Новые",stage:"Новая",count:data.filter(t=>stage(t)==="Новая").length},
 {name:"На уточнении",stage:"Уточнение",count:data.filter(t=>stage(t)==="Уточнение").length},
 {name:"Переданы в Kaiten",stage:"Передана в Kaiten",count:data.filter(t=>stage(t)==="Передана в Kaiten").length}];
 const tasks=data.filter(t=>(!searchTerm||[t.title,t.id,t.description,t.requester].some(x=>String(x||"").toLowerCase().includes(searchTerm.toLowerCase())))&&(!filterStatus||stage(t)===filterStatus)&&(!filterProject||t.project===filterProject));
 return heading("FIT Requests","Заявки","Прием и обработка запросов сотрудников, передача в Kaiten.")+
 '<div class="stats request-stats" role="group" aria-label="Фильтр заявок по этапу">'+counts.map(c=>
 '<button type="button" class="stat stat-filter'+(filterStatus===c.stage?" active":"")+'" data-stage="'+esc(c.stage)+'" aria-pressed="'+(filterStatus===c.stage)+'" aria-label="'+esc(c.name)+': '+c.count+'. Показать заявки">'+
 '<span class="stat-label">'+esc(c.name)+'</span><strong>'+c.count+'</strong></button>').join("")+'</div>'+
 '<div class="tools"><input id="search" aria-label="Поиск заявок" placeholder="⌕ Поиск по названию, ID, описанию" value="'+esc(searchTerm)+'">'+
 '<select id="statusFilter" aria-label="Этап обработки"><option value="">Все этапы</option>'+
 ["Черновик","Новая","Уточнение","Передана в Kaiten"].map(x=>'<option value="'+esc(x)+'" '+(filterStatus===x?"selected":"")+'>'+esc(x)+'</option>').join("")+'</select>'+
 '<select id="projectFilter" aria-label="Проект"><option value="">Все проекты</option>'+projects.map(p=>'<option value="'+esc(p.id)+'" '+(filterProject===p.id?"selected":"")+'>'+esc(p.name)+'</option>').join("")+'</select></div>'+
 '<section class="panel"><div class="panel-header"><h2>Список заявок <span class="muted">('+tasks.length+')</span></h2><span class="badge-mini">Нажми на заявку для просмотра</span></div>'+taskTable(tasks)+'</section>';
};
const detail=()=>{
 const t=data.find(x=>x.id===detailId);if(!t)return requests();
 return '<div class="page-head"><div><div class="eyebrow">ЗАЯВКА / '+esc(t.id)+'</div><h1>'+esc(t.title)+'</h1><p class="sub">'+esc(label(t.project))+' · создана '+longdate(t.created)+'</p></div>'+
 '<div class="toolbar-right"><button class="button secondary" data-page="requests">← К списку</button><button class="button primary" data-edit="'+esc(t.id)+'">✎ Уточнить заявку</button></div></div>'+
 '<div class="detail-layout"><div class="stack"><section class="panel"><div class="panel-header"><h2>Описание запроса</h2>'+badge(stage(t))+'</div><div class="panel-body"><div class="detail-desc">'+esc(t.description||"Описание пока не добавлено")+'</div></div></section></div>'+
 '<section class="panel"><div class="panel-header"><h2>Данные заявки</h2></div><div class="panel-body kv">'+[["ID",t.id],["Проект",label(t.project)],["Инициатор",t.requester],["Подразделение",t.department],["Этап обработки",stage(t)],["Желаемый срок",fmt(t.desiredDue)],["Создана",longdate(t.created)]].map(([a,b])=>'<div class="kv-row"><span>'+esc(a)+'</span><b>'+esc(b||"—")+'</b></div>').join("")+'</div></section></div>';
};
function render(){document.querySelector("#navigation").innerHTML=nav.map(([key,icon,name])=>'<button class="nav-link '+(page===key?"active":"")+'" data-page="'+key+'"><span class="nav-icon">'+icon+'</span><span class="nav-label">'+name+'</span></button>').join("");$("#breadcrumb").textContent=detailId?"Заявки / "+detailId:nav.find(n=>n[0]===page)?.[2]||"Заявки";$("#today").textContent=new Date().toLocaleDateString("ru-RU",{day:"numeric",month:"long",year:"numeric"});$("#main").innerHTML=detailId?detail():requests();bindInputs()}
function bindInputs(){const s=$("#search");if(s)s.addEventListener("input",e=>{searchTerm=e.target.value;const at=e.target.selectionStart;render();const i=$("#search");i.focus();i.setSelectionRange(at,at)});$("#statusFilter")?.addEventListener("change",e=>{filterStatus=e.target.value;render()});$("#projectFilter")?.addEventListener("change",e=>{filterProject=e.target.value;render()})}
function openForm(){/* Replaced by the request-only intake module after app initialization. */}
document.addEventListener("click",e=>{
 const b=e.target.closest("[data-page],[data-action],[data-id],[data-edit],[data-stage]");
 if(!b)return;
 if(b.hasAttribute("data-stage")){filterStatus=b.dataset.stage;detailId=null;page="requests";render();return}
 if(b.dataset.page){page=b.dataset.page;detailId=null;render();return}
 if(b.dataset.id){detailId=b.dataset.id;page="requests";render();return}
 if(b.dataset.edit){openForm(b.dataset.edit);return}
 if(b.dataset.action==="new")openForm();
});
render();