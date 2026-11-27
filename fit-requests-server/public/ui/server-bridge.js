"use strict";
(()=>{
 let known=new Map(),queue=Promise.resolve();
 const deletingIds=new Set();
 const fetchJson=async(path,options={})=>{
  let response;
  try{
   response=await fetch(path,{credentials:"same-origin",cache:"no-store",...options});
  }catch{
   throw Error("Нет связи с сервером. Проверь подключение и повтори попытку.");
  }
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(Error(value.error||("HTTP "+response.status)),{field:value.field});
  return value;
 };
 const payload=t=>{const o={...t};delete o.kaitenSync;delete o.kaitenParent;delete o.kaitenCards;delete o.createdBy;delete o.revision;delete o.id;return o};
 const record=t=>JSON.stringify(payload(t));
 async function reload(){
  const response=await fetchJson("/api/requests");
  data=response.items;known=new Map(response.items.map(x=>[x.id,{revision:x.revision,record:record(x)}]));
  detailId=null;render();return response.items;
 }
 function submit(item,fields,operationId){
  const operation=queue.then(async()=>{
   const path=item?"/api/requests/"+encodeURIComponent(item.id):"/api/requests";
   const response=await fetchJson(path,{
    method:item?"PUT":"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({...fields,operationId,...(item?{revision:item.revision}:{})})
   });
   const saved=response.item;
   if(!saved?.id)throw Error("Сервер не вернул сохраненную заявку");
   known.set(saved.id,{revision:saved.revision,record:record(saved)});
   data=[saved,...data.filter(t=>t.id!==saved.id)];
  });
  queue=operation.catch(()=>{});
  return operation;
 }
 function showError(message){
  let bar=document.getElementById("syncError");
  if(!bar){bar=document.createElement("div");bar.id="syncError";bar.setAttribute("role","alert");bar.style.cssText="position:fixed;bottom:10px;left:12px;right:12px;background:#fee5dc;color:#8c2000;padding:12px 18px;border:1px solid #f3a58b;border-radius:10px;z-index:10000;font-weight:600";document.body.append(bar)}
  bar.textContent="Сохранение не завершено: "+message+". Не закрывай вкладку, пока ошибка не устранена.";
 }
 const escape=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const canManageKaiten=()=>window.FitUser?.role==="admin";
 const previousRender=render;
 render=function(){
  previousRender();
  if(!detailId)return;
  const t=data.find(x=>x.id===detailId);if(!t)return;
  if(canDelete(t)){
   const toolbar=document.querySelector('#main .toolbar-right');
   if(toolbar&&!toolbar.querySelector('[data-delete-request]')){const b=document.createElement('button');b.type='button';b.className='button secondary request-delete';b.dataset.deleteRequest=t.id;b.textContent=t.status==='Черновик'?'Удалить черновик':'Удалить заявку';b.disabled=deletingIds.has(t.id);toolbar.append(b)}
  }
  if(!canManageKaiten()||t.status==="Черновик")return;
  const parent=t.kaitenParent;
  const root=document.querySelector("#main .detail-layout .stack")||document.querySelector("#main");if(!root)return;
  Array.from(root.querySelectorAll("section.panel")).filter(p=>p.querySelector(".panel-header h2")?.textContent==="Интеграция с Kaiten").forEach(p=>p.remove());
  const section=document.createElement("section");section.className="panel";section.id="kaitenParentPanel";
  section.innerHTML='<div class="panel-header"><h2>Основная карточка Kaiten</h2></div>'+
    '<div class="panel-body">'+
    (parent?'<div class="kv">'+
      [["ID",parent.id],["Название",parent.title||"—"],["Статус Kaiten",parent.state??"—"],["Оценка",parent.estimateText||"—"],["Исполнитель (ID)",parent.ownerId||"—"],["Участники (ID)",Array.isArray(parent.memberIds)?parent.memberIds.join(", "):"—"],["Срок",parent.dueDate||"—"],["Плановое начало",parent.plannedStart||"—"],["Плановое завершение",parent.plannedEnd||"—"]].map(([name,val])=>'<div class="kv-row"><span>'+escape(name)+'</span><b>'+escape(val)+'</b></div>').join("")+
      '</div>'+'<p style="margin-top:14px"><button class="button secondary sm" id="unlinkParent" type="button">Отвязать основную карточку</button></p>':
      '<p class="sub">Основная карточка в Kaiten еще не создана. После уточнения заявки PM создает одну основную карточку в Kaiten; дочерние появятся автоматически при декомпозиции.</p>'+
      '<div id="kaitenCreateForm" style="padding:14px;border:1px solid #e5e7eb;border-radius:10px;margin:12px 0"><p class="sub"><strong>Доска: PM · Колонка: Анализ</strong></p><label>Дорожка<select id="createLane" style="width:100%;margin:8px 0" disabled><option value="">Загрузка дорожек...</option></select></label><p id="createKaitenStatus" class="sub"></p><button id="sendToKaiten" type="button" class="button primary sm" disabled>Отправить в Kaiten</button></div>'+
      '<details><summary style="cursor:pointer">Карточка уже существует в Kaiten? Привязать</summary>'+
      '<label style="display:block;margin-top:12px">Название или ID карточки <input id="parentSearchInput" maxlength="120" placeholder="Минимум два символа" style="width:100%;margin:8px 0"></label>'+
      '<button id="parentSearchButton" class="button secondary sm" type="button">Найти карточку</button><div id="parentSearchResults" style="margin-top:12px" aria-live="polite"></div></details>')+
    '</div>';
  root.append(section);
  if(!parent)loadPmLanes();
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
 async function loadPmLanes(){
  if(!canManageKaiten())return;
  const lane=document.getElementById("createLane"),status=document.getElementById("createKaitenStatus"),sendButton=document.getElementById("sendToKaiten");
  if(!lane||!sendButton)return;
  try{
   const destination=await fetchJson("/api/kaiten/pm-destination");
   if(!lane.isConnected)return;
   lane.innerHTML='<option value="">Выбери дорожку</option>'+destination.lanes.map(x=>'<option value="'+escape(x.id)+'">'+escape(x.title)+'</option>').join("");
   lane.disabled=false;sendButton.disabled=true;
   status.textContent="Карточка будет отправлена в PM → Анализ сразу после нажатия кнопки.";
  }catch(err){if(status)status.textContent="Не удалось получить дорожки доски PM: "+err.message}
 }
 document.addEventListener("change",event=>{
  if(event.target.id==="createLane"){
   const button=document.getElementById("sendToKaiten");
   if(button)button.disabled=!event.target.value;
  }
 });
 document.addEventListener("click",async event=>{
  const button=event.target.closest("#sendToKaiten");if(!button||!canManageKaiten())return;
  const request=data.find(x=>x.id===detailId),laneId=document.getElementById("createLane")?.value,status=document.getElementById("createKaitenStatus");
  if(!request||request.kaitenParent||!laneId)return;
  button.disabled=true;if(status)status.textContent="Отправляем карточку в Kaiten...";
  try{
   await queue;
   const result=await fetchJson("/api/requests/"+encodeURIComponent(request.id)+"/kaiten/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({laneId})});
   const response=await fetchJson("/api/requests"),originalId=detailId;
   data=response.items;known=new Map(response.items.map(x=>[x.id,{revision:x.revision,record:record(x)}]));
   detailId=originalId;render();notify("Карточка создана в Kaiten: "+result.cardId);
  }catch(err){
   if(status)status.textContent="Отправка не завершена: "+err.message;
   // Do not re-enable automatically: an ambiguous response could mean Kaiten created the card.
  }
 });
 document.addEventListener("click",async event=>{
  const button=event.target.closest("#parentSearchButton,[data-link-parent],#unlinkParent");if(!button||!canManageKaiten())return;
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
 function canDelete(t){return Boolean(t&&window.FitUser?.telegramId&&String(t.createdBy)===String(window.FitUser.telegramId)&&known.has(t.id))}
 function remove(id){
  const item=data.find(x=>x.id===id);if(!canDelete(item)||deletingIds.has(id))return;
  if(!confirm((item.status==='Черновик'?'Удалить черновик':'Удалить заявку')+' «'+(item.title||'Без названия')+'»? '+(item.status==='Черновик'?'Черновик исчезнет из списка.':'Заявка исчезнет из списка. Связанная карточка Kaiten останется, если она была создана.')))return;
  deletingIds.add(id);
  document.querySelectorAll('[data-delete-request],#deleteIntake').forEach(b=>b.disabled=true);
  const operation=queue.then(async()=>{
   const current=data.find(x=>x.id===id),saved=known.get(id);
   if(!current||!saved||saved.record!==record(current))throw Error('Есть несохраненные изменения. Сначала сохрани заявку или обнови страницу.');
   await fetchJson('/api/requests/'+encodeURIComponent(id),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:saved.revision})});
   known.delete(id);data=data.filter(x=>x.id!==id);
   document.getElementById('requestDialog')?.close();detailId=null;page='requests';render();notify('Заявка удалена');
  });
  queue=operation.catch(err=>notify('Не удалось удалить: '+err.message)).finally(()=>{deletingIds.delete(id);document.querySelectorAll('[data-delete-request],#deleteIntake').forEach(b=>b.disabled=false)});
  return queue;
 }
 document.addEventListener('click',e=>{const b=e.target.closest('[data-delete-request]');if(b)remove(b.dataset.deleteRequest)});
 window.FitRequestPersistence={submit,reload,remove,canDelete};
 function renderCurrentUser(user){
  const analytics=document.getElementById("analyticsNav");
  if(analytics&&user.role==="admin")analytics.style.removeProperty("display");
  const name=document.getElementById("userDisplayName");
  const avatar=document.getElementById("userAvatar");
  // /api/me is populated from the authenticated Telegram session, not editable browser data.
  const display=String(user.displayName||user.telegramId||"Пользователь Telegram").trim();
  if(name){name.textContent=display;name.title=display}
  if(avatar){
    const words=display.split(/\s+/).filter(Boolean);
    const initials=(words.length>1?words[0].slice(0,1)+words[1].slice(0,1):display.slice(0,2)).toLocaleUpperCase("ru-RU");
    avatar.textContent=initials||"?";
  }
}
Promise.all([fetchJson("/api/me"),reload()]).then(([user])=>{window.FitUser=user;renderCurrentUser(user);render()}).catch(err=>{showError("Не удалось загрузить профиль или заявки: "+err.message);notify("Ошибка загрузки с сервера")});
})();
