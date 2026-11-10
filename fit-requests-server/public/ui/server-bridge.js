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
 function showImport(){
  let dialog=document.getElementById("migrationDialog");
  if(!dialog){
   dialog=document.createElement("dialog");dialog.id="migrationDialog";
   dialog.style.cssText="max-width:630px;width:calc(100% - 28px);border-radius:14px;border:1px solid #e5e7eb;padding:25px;color:#252a32";
   dialog.innerHTML='<h2>Данные FIT Requests</h2><p>Заявки хранятся в PostgreSQL. Старые заявки из браузера переносятся только по твоей команде. Уже существующие ID не перезаписываются.</p><p><a href="https://tanchikpet.github.io/fit-service/fit-requests/" target="_blank" rel="noopener">Открыть старый прототип для экспорта JSON ↗</a></p><p><button class="button secondary" id="dbExport" type="button">Скачать резервную копию заявок</button></p><label>Импортировать ранее скачанный JSON<input id="importJson" type="file" accept=".json,application/json" style="display:block;margin:10px 0"></label><p id="importStatus"></p><div class="modal-actions"><button id="importConfirm" class="button primary" type="button" disabled>Импортировать без перезаписи</button><button id="importClose" class="button secondary" type="button">Закрыть</button></div>';
   document.body.append(dialog);
   let imported=null;
   dialog.querySelector("#importJson").addEventListener("change",async ev=>{
    imported=null;dialog.querySelector("#importConfirm").disabled=true;
    try{const file=ev.target.files?.[0];if(!file)return;if(file.size>5e6)throw Error("Размер файла больше 5 МБ");
     const result=JSON.parse(await file.text());const list=Array.isArray(result)?result:result.items;
     if(!Array.isArray(list)||list.length>2000)throw Error("Ожидается массив не более 2000 заявок");
     imported=list;dialog.querySelector("#importStatus").textContent="В файле "+list.length+" заявок. Существующие идентификаторы будут пропущены.";
     dialog.querySelector("#importConfirm").disabled=false;
    }catch(e){dialog.querySelector("#importStatus").textContent="Ошибка файла: "+e.message}
   });
   dialog.querySelector("#dbExport").onclick=()=>{
    const blob=new Blob([JSON.stringify({format:"fit-requests-backup-v1",items:data,exportedAt:new Date().toISOString()},null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="fit-requests-backup.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
   };
   dialog.querySelector("#importConfirm").onclick=async()=>{
    if(!imported||!confirm("Перенести "+imported.length+" заявок? Уже существующие ID останутся без изменений."))return;
    const button=dialog.querySelector("#importConfirm");button.disabled=true;
    try{await queue;const result=await fetchJson("/api/requests/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({items:imported})});await reload();
      dialog.querySelector("#importStatus").textContent="Перенесено: "+result.imported+". Пропущено (ID уже существует): "+result.skipped+".";
      notify("Импорт завершен");
    }catch(e){dialog.querySelector("#importStatus").textContent="Импорт не выполнен: "+e.message}finally{button.disabled=false}
   };
   dialog.querySelector("#importClose").onclick=()=>dialog.close();
  }
  dialog.showModal();
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
      '<details><summary style="cursor:pointer">Карточка уже есть в Kaiten? Привязать существующую</summary>'+
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
 window.FitRequestPersistence={save,showImport,reload};
 reload().catch(err=>{showError("Не удалось загрузить заявки: "+err.message);notify("Ошибка загрузки с сервера")});
})();
