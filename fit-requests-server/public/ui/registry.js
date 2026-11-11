"use strict";
(()=>{
const $=s=>document.querySelector(s),esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let isPm=false,model=null,candidates={items:[]},checks={checks:{}},busy=false,loaded=false,scope='active',showExcluded=false;
const categories=["Сайты и проекты","Федеральные акции","Сезонные акции","Флеш акции","Акции","Акции СРК","Акции ИЛР","Партнерские акции","Интеграции","Другие акции","Интеграции с партнерами","Другие сервисы"];
const message=m=>{$('#notice').textContent=m};
function safeUrl(s){try{const u=new URL(s);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null}catch{return null}}
const link=(url,text)=>safeUrl(url)?'<a href="'+esc(safeUrl(url))+'" target="_blank" rel="noopener noreferrer">'+esc(text||url)+'</a>':'<code>'+esc(text||url)+'</code>';
async function api(path,method='GET',body){const r=await fetch(path,{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});const result=await r.json();if(!r.ok)throw Error(result.error||'Ошибка '+r.status);return result}
async function refresh(){try{const [user,snapshot]=await Promise.all([api('/api/me'),api('/api/registry')]);isPm=user.role==='admin';model={entries:snapshot.entries};candidates={items:snapshot.candidates};checks=snapshot.checks;loaded=true;$('#add').hidden=!isPm;$('#run').hidden=!isPm;$('#run').disabled=Boolean(checks.running);$('#userDisplayName').textContent=user.displayName||'Пользователь';$('#userAvatar').textContent=(user.displayName||'?').slice(0,2);$('#today').textContent=new Date().toLocaleDateString('ru-RU');render();message(checks.running?'Проверка выполняется. Результаты обновятся автоматически.':checks.lastError||'')}catch(e){message(e.message)}}
function suggestedProject(url){
 const safe=safeUrl(url);if(!safe)return '';const host=new URL(safe).hostname.replace(/^www\./,'');
 const fixed={'fitautolab.ru':'FIT LAB','fleet.fitauto.ru':'FIT FLEET','fitauto.ru':'Основной сайт — fitauto.ru','fitavto.kz':'Основной сайт — fitauto.ru'};
 if(fixed[host])return fixed[host];
 const projects=new Set((model?.entries||[]).filter(e=>[e.ru,e.kz].some(u=>{try{return new URL(u).hostname.replace(/^www\./,'')===host}catch{return false}})).map(e=>e.project).filter(Boolean));
 return projects.size===1?[...projects][0]:'';
}
const issueLabels={missing:'Страница не найдена',server:'Ошибка сайта',check:'Не удалось проверить',redirect:'Проблема с редиректом'};
function checkIssues(c){
 if(!c)return [];
 const issues=[];
 if(c.status===404||c.status===410)issues.push('missing');
 else if(c.status>=500&&c.status<600)issues.push('server');
 else if(c.error||!c.status||c.status>=400)issues.push('check');
 if(c.expectedMismatch||c.changed||c.status>=300&&c.status<400)issues.push('redirect');
 return issues;
}
function awaitingRequestedCheck(e){
 if(!e.attentionRequestedAt)return false;
 const c=checks.checks?.[e.attentionUrl];
 return !c?.checkedAt||Date.parse(c.checkedAt)<=Date.parse(e.attentionRequestedAt);
}
function entryIssues(e){
 if(e.isTemplate)return [];
 return [...new Set([...(awaitingRequestedCheck(e)?['check']:[]),...[e.ru,e.kz].filter(Boolean).flatMap(u=>checkIssues(checks.checks?.[safeUrl(u)||u]))])];
}
function checkView(url){
 const c=checks.checks?.[safeUrl(url)||url];if(!c)return '<span class="status neutral">Еще не проверен</span>';
 const failed=c.error||!c.status||c.status>=400;
 const redirected=c.finalUrl&&safeUrl(c.finalUrl)!==safeUrl(url)||c.status>=300&&c.status<400;
 const issues=checkIssues(c);const label=issues.length?issues.map(k=>issueLabels[k]).join(' · '):redirected?'Редирект':'Доступен';
 return '<details class="check-details"><summary><span class="status '+(issues.length?'warning':redirected?'neutral':'good')+'">'+label+'</span></summary><div class="check-info">'+(c.error?esc(c.error):'HTTP '+esc(c.status))+'<br>'+esc(new Date(c.checkedAt).toLocaleString('ru-RU'))+(c.finalUrl?'<p>Фактический адрес: '+link(c.finalUrl)+'</p>':'')+(c.changed?'<p>Адрес назначения изменился. Ранее: '+link(c.previousFinalUrl)+'</p>':'')+(c.expectedMismatch?'<p>Не совпадает с редиректом в реестре</p>':'')+'</div></details>';
}
function row(e){
 const urls=[['RU',e.ru],['KZ',e.kz]].filter(([,u])=>u);
 return '<tr><td><div class="entry-name">'+esc(e.description||'Без названия')+'</div>'+urls.map(([k,u])=>'<div class="address"><span class="tag">'+k+'</span>'+link(u)+'</div>').join('')+'<details class="entry-details"><summary>Подробнее</summary><dl><dt>Ответственный</dt><dd>'+esc(e.owner||'Не указан')+'</dd><dt>Срок акции</dt><dd>'+esc(e.expires||'Не указан')+'</dd><dt>Редирект RU</dt><dd>'+(e.redirectRu?link(e.redirectRu):'Не указан')+'</dd><dt>Редирект KZ</dt><dd>'+(e.redirectKz?link(e.redirectKz):'Не указан')+'</dd><dt>Заявка</dt><dd>'+esc(e.requestId||'Не связана')+'</dd></dl></details></td><td>'+esc(e.project)+'</td><td>'+urls.map(([k,u])=>'<div class="check-line">'+(urls.length>1?'<span class="tag">'+k+'</span>':'')+(e.isTemplate?'<span class="status neutral">Шаблон адреса</span>':(awaitingRequestedCheck(e)&&u===e.attentionUrl?'<span class="status warning">Требует проверки · отмечено PM</span>':checkView(u)))+'</div>').join('')+'</td><td>'+(isPm?'<button class="secondary" data-edit="'+esc(e.id)+'">Изменить</button>':'—')+'</td></tr>';
}
function table(rows,review=false){return '<div class="table-scroll"><table><thead><tr><th scope="col">Адрес и название</th><th scope="col">'+(review?'Предполагаемый проект':'Проект')+'</th><th scope="col">'+(review?'Причина обнаружения':'Статус проверки')+'</th><th scope="col">Действия</th></tr></thead><tbody>'+rows+'</tbody></table></div>'}
function group(name,rows,open=false){return '<details class="group"'+(open?' open':'')+'><summary>'+esc(name)+' <span class="group-count">'+rows.length+'</span></summary>'+table(rows.map(row).join(''))+'</details>'}

const ownSections=['Федеральные акции','Сезонные акции','Флеш акции','Акции СРК','Акции ИЛР','Партнерские акции','Другие акции','Интеграции с партнерами','Другие сервисы'];
const teamProjects=[
 {name:'ФИТЛАБ',match:/фитлаб|fit.?lab/i,hosts:['fitautolab.ru'],owner:'Отдел ФитЛаб · руководитель отдела маркетинга ФитЛаба'},
 {name:'Франчшоп',match:/franchshop|франчшоп/i,hosts:['franchshop.fitauto.ru','fs.fitauto.ru'],owner:'Отдел franchshop · руководитель отдела'},
 {name:'ФИТФЛИТ',match:/fit.?fleet|фитфлит/i,hosts:['fleet.fitauto.ru'],owner:'Продакт ФИТФЛИТ'},
 {name:'Франшиза',match:/франшиза/i,hosts:['fran.fitauto.ru','franch.fitavto.kz'],owner:'Отдел B2B-маркетинга · руководитель отдела'}
];
function hostOf(value){try{return new URL(value).hostname.replace(/^www\./,'')}catch{return ''}}
function teamOf(e){return teamProjects.find(t=>t.match.test(e.project||'')||[e.ru,e.kz].some(u=>t.hosts.includes(hostOf(u))))}
function ownSection(e){const path=e.groupPath||[];return path.find(k=>ownSections.includes(k))||(path.includes('Акции')?'Другие акции':path.includes('Интеграции')?'Интеграции с партнерами':'Другие сервисы')}
function homepage(host,label){return '<div class="homepage"><span>'+esc(label)+'</span>'+link('https://'+host+'/',host)+checkView('https://'+host+'/')+'</div>'}
function overview(items,q){
 const main=[],cities=[],owned=new Map(ownSections.map(n=>[n,[]])),teams=new Map(teamProjects.map(t=>[t,[]]));
 for(const e of items){
 const team=teamOf(e);
 if(team)teams.get(team).push(e);
 else if(e.groupPath?.includes('Города'))cities.push(e);
 else if(e.project?.startsWith('Основной сайт')||[e.ru,e.kz].some(u=>['fitauto.ru','fitavto.kz'].includes(hostOf(u))))main.push(e);
 else owned.get(ownSection(e)).push(e);
 }
 let html='';
 if(!q||main.length||cities.length){
 const roots=main.filter(e=>[e.ru,e.kz].some(u=>{try{const x=new URL(u);return ['fitauto.ru','fitavto.kz'].includes(hostOf(u))&&x.pathname==='/'}catch{return false}}));
 const pages=main.filter(e=>!roots.includes(e));
 html='<section class="primary-project"><div class="overview-heading"><h2>Основной сайт FIT SERVICE</h2><span class="owner-badge">Веб-ресурсы</span></div><div class="homepages">'+homepage('fitauto.ru','Россия')+homepage('fitavto.kz','Казахстан')+'</div><div class="project-details">'+(roots.length?group('Данные основных доменов',roots,false):'')+(pages.length?group('Внутренние страницы',pages,Boolean(q)):'')+(cities.length?'<div class="nested-group">'+group('Города',cities,Boolean(q))+'</div>':'')+'</div></section>';
 }
 const ownCount=[...owned.values()].reduce((n,rs)=>n+rs.length,0);
 if(!q||ownCount)html+='<section class="own-projects"><div class="overview-heading"><h2>Веб-ресурсы</h2></div><p class="overview-caption">Акции, партнерские интеграции и другие сервисы</p>'+[...owned].filter(([,rs])=>!q||rs.length).map(([name,rs])=>rs.length?group(name,rs,Boolean(q)):'<div class="empty-category">'+esc(name)+' <span class="group-count">0</span></div>').join('')+'</section>';
 const teamCount=[...teams.values()].reduce((n,rs)=>n+rs.length,0);
 if(!q||teamCount)html+='<details class="other-projects"'+(q?' open':'')+'><summary>Проекты других команд <span class="group-count">'+(q?[...teams.values()].filter(rs=>rs.length).length:teamProjects.length)+'</span></summary><p class="overview-caption">Ведение этих проектов — в зоне ответственности профильных команд.</p>'+[...teams].filter(([,rs])=>!q||rs.length).map(([t,rs])=>'<section class="team-project"><h3>'+esc(t.name)+'</h3><p class="team-owner">'+esc(t.owner)+'</p><div class="homepages">'+t.hosts.map(h=>homepage(h,'Главная страница')).join('')+'</div>'+(rs.length?group('Страницы проекта',rs,Boolean(q)):'')+'</section>').join('')+'</details>';
 return html;
}
function render(){
 if(!model)return;
 $('#monitorStatus').textContent=checks.emailStatus||'Уведомления Telegram ожидают подключения.';
 $('#lastScan').textContent=checks.running?'Проверка выполняется…':checks.checkedAt?'Последняя проверка: '+new Date(checks.checkedAt).toLocaleString('ru-RU'):'Проверок пока нет';
 const errors=checks.discoveryErrors||[];$('#discoveryWarning').hidden=!errors.length;
 $('#discoveryErrors').replaceChildren(...errors.map(error=>{const item=document.createElement('li');item.textContent=error;return item}));
 if(!errors.length)$('#discoveryDetails').open=false;
 const counts={attention:model.entries.filter(e=>e.status!=='archive'&&entryIssues(e).length).length,active:model.entries.filter(e=>e.status!=='archive').length,review:candidates.items.filter(e=>e.state==='pending').length,archive:model.entries.filter(e=>e.status==='archive').length};
 for(const [key,count] of Object.entries(counts))document.querySelector('[data-count="'+key+'"]').textContent=count;
 $('#attentionTools').hidden=scope!=='attention';$('#reviewTools').hidden=scope!=='review';$('#excludedCount').textContent=candidates.items.filter(e=>e.state==='dismissed').length;
 $('#showExcluded').setAttribute('aria-pressed',String(showExcluded));
 $('#showExcluded').firstChild.textContent=showExcluded?'← На проверку · исключенных ':'Исключенные ';
 const q=$('#search').value.trim().toLowerCase();
 const match=e=>[e.ru,e.kz,e.url,e.description,e.project,e.owner,e.url?suggestedProject(e.url):''].join(' ').toLowerCase().includes(q);
 const items=scope==='review'?candidates.items.filter(e=>e.state===(showExcluded?'dismissed':'pending')&&match(e)):model.entries.filter(e=>(scope==='archive'?e.status==='archive':e.status!=='archive')&&match(e)&&(scope!=='attention'||entryIssues(e).some(reason=>!$('#attentionReason').value||reason===$('#attentionReason').value)));
 $('#summary').textContent=(scope==='review'&&showExcluded?'Исключенные · ':'')+items.length+' записей'+(q?' по запросу':'');
 if(!items.length&&!(scope==='active'&&!q)){$('#list').innerHTML='<div class="empty">'+(q?'Ничего не найдено. Попробуй другой запрос.':scope==='review'?(showExcluded?'Нет исключенных адресов':'Все найденные адреса разобраны'):scope==='attention'?'По последней проверке проблем с выбранной причиной нет':'В этом разделе пока нет записей')+'</div>';return}
 if(scope==='review'){
 $('#list').innerHTML=table(items.map(e=>'<tr><td>'+link(e.url)+'</td><td>'+esc(suggestedProject(e.url)||'Не определен')+'</td><td><div>'+esc(e.source||'Найден при сканировании')+'</div><small class="muted">'+(e.foundAt?'Найден: '+esc(new Date(e.foundAt).toLocaleDateString('ru-RU')):'')+'</small></td><td><div class="row-actions">'+(isPm?(showExcluded?'<button class="secondary" data-restore="'+esc(e.id)+'">Вернуть на проверку</button>':'<button class="secondary" data-approve="'+esc(e.id)+'">Добавить</button><button class="text-button" data-dismiss="'+esc(e.id)+'">Не учитывать</button>'):'—')+'</div></td></tr>').join(''),true);return;
 }
 if(scope==='active'){$('#list').innerHTML=overview(items,q);return}
 const main=[],cities=[],groups=new Map();
 for(const e of items){
 if(e.groupPath?.includes('Города'))cities.push(e);
 else if(e.project?.startsWith('Основной сайт'))main.push(e);
 else{const key=e.groupPath?.filter(x=>x!=='Архив').join(' / ')||e.project||'Другие страницы';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e)}
 }
 let html='';
 if(main.length||cities.length)html='<details class="group" open><summary>Основной сайт <span class="group-count">'+(main.length+cities.length)+'</span></summary>'+(main.length?table(main.map(row).join('')):'')+(cities.length?'<div class="nested-group">'+group('Города',cities,Boolean(q)||scope==='attention')+'</div>':'')+'</details>';
 html+=[...groups].map(([name,rs])=>group(name,rs,Boolean(q)||scope==='attention'||groups.size<4)).join('');
 $('#list').innerHTML=html;
}
function openEditor(e=null,candidate=null){if(!isPm)return;if(!loaded)return message('Сначала дождись загрузки реестра.');$('#entryForm').reset();$('#editorError').textContent='';$('#editorTitle').textContent=e?'Редактировать страницу':candidate?'Адрес на проверке':'Новая страница';$('#entryId').value=e?.id||'';$('#candidateId').value=candidate?.id||'';for(const key of ['ru','kz','redirectRu','redirectKz','description','expires','owner','project','requestId'])$('#'+key).value=e?.[key]||'';if(candidate){$('#ru').value=candidate.url;$('#project').value=suggestedProject(candidate.url)}$('#extraFields').open=false;$('#projects').innerHTML=[...new Set(model.entries.map(x=>x.project))].map(x=>'<option value="'+esc(x)+'">').join('');$('#category').innerHTML=categories.map(x=>'<option>'+esc(x)+'</option>').join('');$('#category').value=e?.groupPath?.find(x=>categories.includes(x))||'Сайты и проекты';$('#status').value=e?.status||'active';if(e?.isTemplate){$('#ru').type='text';$('#kz').type='text'}else{$('#ru').type='url';$('#kz').type='url'}$('#editor').showModal()}
$('#entryForm').addEventListener('submit',async ev=>{ev.preventDefault();if(busy||!isPm)return;const id=$('#entryId').value,old=model.entries.find(e=>e.id===id);const entry={id:id||undefined,revision:old?.revision,category:$('#category').value,candidateId:$('#candidateId').value};for(const key of ['ru','kz','redirectRu','redirectKz','description','expires','owner','project','requestId','status'])entry[key]=$('#'+key).value.trim();busy=true;$('#saveEntry').disabled=true;try{await api('/api/registry/entries','POST',entry);$('#editor').close();await refresh();message('Сохранено')}catch(e){$('#editorError').textContent=e.message}finally{busy=false;$('#saveEntry').disabled=false}});
$('#list').addEventListener('click',async ev=>{const b=ev.target.closest('button');if(!b||!isPm)return;if(b.dataset.edit)openEditor(model.entries.find(e=>e.id===b.dataset.edit));if(b.dataset.approve)openEditor(null,candidates.items.find(e=>e.id===b.dataset.approve));if(b.dataset.dismiss||b.dataset.restore){if(busy)return;busy=true;b.disabled=true;try{await api('/api/registry/candidates/'+(b.dataset.restore?'restore':'dismiss'),'POST',{id:b.dataset.restore||b.dataset.dismiss});await refresh();message(b.dataset.restore?'Адрес возвращен на проверку':'Адрес исключен. Его можно вернуть из списка исключенных.')}catch(e){message(e.message)}finally{busy=false;b.disabled=false}}});
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());$('#add').onclick=()=>openEditor();
$('#about').onclick=()=>$('#serviceInfo').showModal();
$('#showExcluded').onclick=()=>{showExcluded=!showExcluded;render()};
for(const id of ['ru','kz'])$('#'+id).addEventListener('change',()=>{if(!$('#entryId').value&&!$('#project').value)$('#project').value=suggestedProject($('#'+id).value)});
$('#attentionReason').onchange=render;$('#search').oninput=render;const tabs=[...document.querySelectorAll('[data-scope]')];
function selectScope(tab){scope=tab.dataset.scope;for(const item of tabs){const selected=item===tab;item.setAttribute('aria-selected',String(selected));item.tabIndex=selected?0:-1}$('#registryPanel').setAttribute('aria-labelledby',tab.id);render()}
tabs.forEach((tab,index)=>{tab.onclick=()=>selectScope(tab);tab.onkeydown=ev=>{let next;if((ev.key==='ArrowRight'||ev.key==='ArrowDown'))next=(index+1)%tabs.length;else if((ev.key==='ArrowLeft'||ev.key==='ArrowUp'))next=(index+tabs.length-1)%tabs.length;else if(ev.key==='Home')next=0;else if(ev.key==='End')next=tabs.length-1;else return;ev.preventDefault();selectScope(tabs[next]);tabs[next].focus()}});
$('#run').onclick=async()=>{if(!isPm)return;$('#run').disabled=true;try{await api('/api/registry/run','POST',{});checks.running=true;render();message('Проверка запущена. Результаты обновятся автоматически.')}catch(e){message(e.message);$('#run').disabled=false}};
$('#add').hidden=true;$('#run').hidden=true;refresh();setInterval(()=>{if(checks.running&&!busy&&!$('#editor').open)refresh()},15000);
})();
