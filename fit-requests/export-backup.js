"use strict";
(()=>{
 const button=document.createElement("button");
 button.type="button";button.className="icon-btn";button.title="Скачать резервную копию локальных заявок JSON";button.setAttribute("aria-label","Скачать резервную копию заявок");button.textContent="⇩ JSON";
 button.style.cssText="width:auto;min-width:75px;padding:0 9px";
 button.addEventListener("click",()=>{
  const key="fit-requests-prototype-v1";
  let items;
  try{const raw=localStorage.getItem(key);if(!raw){alert("В этом браузере нет сохраненных локальных заявок FIT Requests.");return}
   items=JSON.parse(raw);if(!Array.isArray(items))throw Error("Заявки хранятся в неожиданном формате");
   const content=JSON.stringify({format:"fit-requests-local-backup-v1",items,exportedAt:new Date().toISOString()},null,2);
   const url=URL.createObjectURL(new Blob([content],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="fit-requests-local-backup.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(e){alert("Не удалось экспортировать локальные заявки: "+e.message)}
 });
 const actions=document.querySelector(".top-actions");if(actions)actions.insertBefore(button,actions.firstChild);
})();
