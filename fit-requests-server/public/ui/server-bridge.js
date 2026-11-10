"use strict";
(()=>{
 let known=new Map(),queue=Promise.resolve(),busy=false;
 const fetchJson=async(path,options={})=>{const r=await fetch(path,{credentials:"same-origin",cache:"no-store",...options});const value=await r.json().catch(()=>({}));if(!r.ok)throw Error(value.error||("HTTP "+r.status));return value};
 const payload=t=>{const o={...t};delete o.kaitenSync;delete o.kaitenParent;delete o.kaitenCards;delete o.createdBy;delete o.revision;delete o.id;return o};
 const record=t=>JSON.stringify(payload(t));
 async function reload(){
  const response=await fetchJson("/api/requests");
  data=response.items;known=new Map(response.items.map(x=>[x.id,{revision:x.revision,record:record(x)}]));
  detailId=null;render();return response.items;
 }
 async function writeOne(item){
  const existing=known.get(item.id);
  if(existing&&existing.record===record(item))return;
  const updated=existing
   ?await fetchJson("/api/requests/"+encodeURIComponent(item.id),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({...payload(item),revision:existing.revision})})
   :await fetchJson("/api/requests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload(item))});
  const saved=updated.item;
  if(!saved||!saved.id)throw Error("Сервер не вернул сохраненную заявку");
  known.delete(item.id);
  known.set(saved.id,{revision:saved.revision,record:record(saved)});
  const i=data.findIndex(x=>x.id===item.id);
  if(i>=0){data[i]={...data[i],...saved};if(detailId===item.id)detailId=saved.id}
  render();
 }
 function save(snapshot){
  const changed=snapshot.filter(x=>!known.has(x.id)||known.get(x.id).record!==record(x));
  queue=queue.then(async()=>{if(!changed.length)return;for(const item of changed)await writeOne(item);notify("Сохранено в PostgreSQL")})
   .catch(err=>{notify("Не сохранено на сервере: "+err.message);showError(err.message)});
 }
 function showError(message){
  let bar=document.getElementById("syncError");
  if(!bar){bar=document.createElement("div");bar.id="syncError";bar.setAttribute("role","alert");bar.style.cssText="position:fixed;bottom:10px;left:12px;right:12px;background:#fee5dc;color:#8c2000;padding:12px 18px;border:1px solid #f3a58b;border-radius:10px;z-index:10000;font-weight:600";document.body.append(bar)}
  bar.textContent="Сохранение не завершено: "+message+". Не закрывай вкладку, пока ошибка не устранена.";
 }
 const escape=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const previousRender=render;
 render=function(){
  previousRender();
  if(!detailId)return;
  const t=data.find(x=>x.id===detailId);if(!t)return;
  const parent=t.kaitenParent;
  const root=document.querySelector("#main .detail-layout .stack")||document.querySelector("#main");if(!root)return;
  Array.from(root.querySelectorAll("section.panel")).filter(p=>p.querySelector(".panel-header h2")?.textContent==="Интеграция с Kaiten").forEach(p=>p.remove());
  const section=document.createElement("section");section.className="panel";section.id="kaitenParentPanel";
  section.innerHTML='<div class="panel-header"><h2>Основная карточка Kaiten</h2></div>'+
    '<div class="panel-body">'+
    (parent?'<div class="kv">'+
      [["ID",parent.id],["Название",parent.title||"—"],["Статус Kaiten",parent.state??"—"],["Оценка",parent.estimateText||"—"],["Исполнитель (ID)",parent.ownerId||"—"],["Участники (ID)",Array.isArray(parent.memberIds)?parent.memberIds.join(", "):"—"],["Срок",parent.dueDate||"—"],["Плановое начало",parent.plannedStart||"—"],["Плановое завершение",parent.plannedEnd||"—"]].map(([name,val])=>'<div class="kv-row"><span>'+escape(name)+'</span><b>'+escape(val)+'</b></div>').join("")+
      '</div><p style="margin-top:14px"><button class="button secondary sm" id="unlinkParent" type="button">Отвязать основную карточку</button></p>':
      '<p class="sub">Основная карточка в Kaiten еще не создана. После уточнения заявки PM создает одну основную карточку в Kaiten; дочерние появятся автоматически при декомпозиции.</p>'+
      '<div style="margin:14px 0"><button type="button" class="button primary sm" id="startCreateKaiten">Создать карточку в Kaiten</button></div>'+
      '<div id="kaitenCreateForm" hidden style="padding:14px;border:1px solid #e5e7eb;border-radius:10px;margin:12px 0"><h3 style="margin:0 0 12px">Создание основной карточки</h3><p class="sub">Карточка будет создана только после нажатия кнопки подтверждения. Создается одна карточка с названием и описанием заявки.</p><label>Доска<select id="createBoard" style="width:100%;margin:8px 0"><option value="">Выбери доску</option></select></label><label>Колонка<select id="createColumn" style="width:100%;margin:8px 0"><option value="">Сначала выбери доску</option></select></label><label>Дорожка<select id="createLane" style="width:100%;margin:8px 0"><option value="">По умолчанию</option></select></label><p id="createKaitenStatus" class="sub"></p><button id="confirmCreateKaiten" type="button" class="button primary sm" disabled>Подтвердить создание в Kaiten</button></div>'+
      '<details><summary style="cursor:pointer">Карточка уже существует в Kaiten? Привязать</summary>'+
      '<label style="display:block;margin-top:12px">Название или ID карточки <input id="parentSearchInput" maxlength="120" placeholder="Минимум два символа" style="width:100%;margin:8px 0"></label>'+
      '<button id="parentSearchButton" class="button secondary sm" type="button">Найти карточку</button><div id="parentSearchResults" style="margin-top:12px" aria-live="polite"></div></details>')+
    '</div>';
  root.append(section);
  const childrenSection=document.createElement("section");childrenSection.id="kaitenChildrenPanel";childrenSection.className="panel";
  childrenSection.innerHTML='<div class="panel-header"><h2>Дочерние задачи Kaiten</h2></div><div class="panel-body" id="kaitenChildrenContent"><p class="sub">'+(parent?"Получаем дочерние задачи из Kaiten…":"После появления основной карточки здесь будут дочерние задачи.")+'</p></div>';
  root.append(childrenSection);
  if(parent){
   const requestId=t.id,parentId=String(parent.id);
   fetchJson("/api/requests/"+encodeURIComponent(requestId)+"/kaiten/children").then(result=>{
    if(detailId!==requestId||String(data.find(x=>x.id===requestId)?.kaitenParent?.id)!==parentId)return;
    const content=document.getElementById("kaitenChildrenContent");if(!content)return;
    if(!result.items?.length){content.innerHTML='<p class="sub">Дочерних карточек пока нет.</p>';return}
    content.innerHTML='<p class="sub">Всего: '+result.items.length+'. Данные получены непосредственно из Kaiten.</p><div class="table-wrap"><table><thead><tr><th>ЗАДАЧА</th><th>СТАТУС</th><th>ИСПОЛНИТЕЛЬ</th><th>ОЦЕНКА</th><th>СРОК</th></tr></thead><tbody>'+
      result.items.map(c=>'<tr><td><strong>'+escape(c.title)+'</strong><br><small>ID '+escape(c.id)+'</small></td><td>'+escape(c.state??"—")+'</td><td>'+escape(c.ownerId||"—")+'</td><td>'+escape(c.estimateText||"—")+'</td><td>'+escape(c.dueDate||"—")+'</td></tr>').join("")+
      '</tbody></table></div>';
   }).catch(err=>{const content=document.getElementById("kaitenChildrenContent");if(content)content.textContent="Не удалось загрузить дочерние задачи: "+err.message});
  }
 };
 document.addEventListener("click",async event=>{
  const b=event.target.closest("#startCreateKaiten,#confirmCreateKaiten");
  if(!b)return;
  const req=data.find(x=>x.id===detailId);if(!req||req.kaitenParent)return;
  const panel=document.getElementById("kaitenCreateForm"),status=document.getElementById("createKaitenStatus");
  if(b.id==="startCreateKaiten"){
   panel.hidden=false;b.disabled=true;
   try{
    const r=await fetchJson("/api/kaiten/boards");
    const select=document.getElementById("createBoard");
    select.innerHTML='<option value="">Выбери доску</option>'+r.items.map(x=>'<option value="'+escape(x.id)+'">Доска #'+escape(x.id)+' ('+escape(x.cardCount)+' карточек)</option>').join("");
    status.textContent="Выбери доску — загрузим ее название, колонки и дорожки из Kaiten.";
   }catch(e){status.textContent="Не удалось загрузить доски: "+e.message;b.disabled=false}
   return;
  }
  const boardId=document.getElementById("createBoard")?.value,
        columnId=document.getElementById("createColumn")?.value,
        laneId=document.getElementById("createLane")?.value;
  if(!boardId||!columnId){status.textContent="Выбери доску и колонку";return}
  if(!confirm("Создать одну основную карточку в Kaiten для "+req.id+"? Это изменение в реальной доске Kaiten."))return;
  b.disabled=true;status.textContent="Отправляем карточку в Kaiten...";
  try{
   await queue;
   const result=await fetchJson("/api/requests/"+encodeURIComponent(req.id)+"/kaiten/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({boardId,columnId,laneId:laneId||null})});
   const response=await fetchJson("/api/requests"),oldId=detailId;
   data=response.items;known=new Map(response.items.map(x=>[x.id,{revision:x.revision,record:record(x)}]));
   detailId=oldId;render();notify("Карточка Kaiten создана: "+result.cardId);
  }catch(e){status.textContent="Не удалось подтвердить создание: "+e.message+". Не повторяй отправку, пока не проверена карточка.";b.disabled=false}
 });
 document.addEventListener("change",async event=>{
  if(event.target.id!=="createBoard"&&event.target.id!=="createColumn")return;
  const status=document.getElementById("createKaitenStatus");
  const board=document.getElementById("createBoard"),column=document.getElementById("createColumn"),lane=document.getElementById("createLane"),confirmButton=document.getElementById("confirmCreateKaiten");
  if(!board||!column||!lane||!confirmButton)return;
  if(event.target.id==="createBoard"){
   confirmButton.disabled=true;column.innerHTML='<option value="">Загрузка...</option>';lane.innerHTML='<option value="">По умолчанию</option>';
   if(!board.value){column.innerHTML='<option value="">Сначала выбери доску</option>';return}
   try{
    const info=await fetchJson("/api/kaiten/boards/"+encodeURIComponent(board.value));
    board.options[board.selectedIndex].textContent=info.title+" (#"+info.id+")";
    column.innerHTML='<option value="">Выбери колонку</option>'+info.columns.map(c=>'<option value="'+escape(c.id)+'">'+escape(c.title)+'</option>').join("");
    lane.innerHTML='<option value="">По умолчанию</option>'+info.lanes.map(l=>'<option value="'+escape(l.id)+'">'+escape(l.title)+'</option>').join("");
    status.textContent=info.columns.length?"Выбери колонку, затем подтверди создание":"У доски не найдены доступные колонки";
   }catch(e){column.innerHTML='<option value="">Недоступно</option>';status.textContent="Ошибка получения доски: "+e.message}
  }
  confirmButton.disabled=!(board.value&&column.value);
 });
 document.addEventListener("click",async event=>{
  const button=event.target.closest("#parentSearchButton,[data-link-parent],#unlinkParent");if(!button)return;
  const t=data.find(x=>x.id===detailId);if(!t)return;
  if(button.id==="parentSearchButton"){
   const q=document.getElementById("parentSearchInput")?.value.trim(),out=document.getElementById("parentSearchResults");
   if(!q||q.length<2){if(out)out.textContent="Введите минимум два символа";return}
   button.disabled=true;
   try{const found=await fetchJson("/api/kaiten/search?q="+encodeURIComponent(q));
    if(out)out.innerHTML=found.items.length?found.items.map(c=>'<div class="demo-card"><div><strong>'+escape(c.title)+'</strong><small>ID '+escape(c.id)+' · '+escape(c.state??"—")+'</small></div><button type="button" class="button secondary sm" data-link-parent="'+escape(c.id)+'">Назначить основной</button></div>').join(""):"Карточки не найдены";
   }catch(err){if(out)out.textContent="Ошибка поиска: "+err.message}finally{button.disabled=false}return;
  }
  const cardId=button.dataset.linkParent||t.kaitenParent?.id,action=button.id==="unlinkParent"?"unlink":"link";
  if(!cardId)return;
  if(!confirm(action==="link"?"Назначить карточку "+cardId+" основной для заявки "+t.id+"?":"Отвязать основную карточку? Дочерние связи в Kaiten не изменятся."))return;
  button.disabled=true;
  try{
   await queue;
   await fetchJson("/api/requests/"+encodeURIComponent(t.id)+"/kaiten",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({cardId:String(cardId),action})});
   const oldId=detailId,response=await fetchJson("/api/requests");data=response.items;
   known=new Map(response.items.map(x=>[x.id,{revision:x.revision,record:record(x)}]));
   detailId=oldId;render();notify(action==="link"?"Основная карточка назначена":"Основная карточка отвязана");
  }catch(err){button.disabled=false;notify("Не удалось изменить связь: "+err.message)}
 });
 window.FitRequestPersistence={save,reload};
 reload().catch(err=>{showError("Не удалось загрузить заявки: "+err.message);notify("Ошибка загрузки с сервера")});
})();
