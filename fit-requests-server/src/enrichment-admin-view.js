import {steps} from "./enrichment-admin.js";
const titles={dictionaries:"Справочники",pilot:"Пробная партия",repeat:"Повтор той же партии",
 verify:"Проверка пробной партии",activity:"Целевая проверка активности",detail:"Детальные карточки, роли и теги",
 comments:"Комментарии",relations:"Связи и чек-листы",blockers:"Блокировки",
 authors:"Авторы перемещений",final:"Итоговая проверка"};
const labels={done:"Завершено",running:"Выполняется",stopped:"Остановлено",failed:"Требуется внимание"};
const settings = new Intl.DateTimeFormat("ru-RU",{dateStyle:"short",timeStyle:"short",timeZone:"Asia/Novosibirsk"});
const format=value=>value?settings.format(new Date(value))+" НСК":"—";

export function enrichmentAdminPanel(state,escape){
 if (!state.available) return '<details class="card" id="kaiten-enrichment"><summary>Дополнительные источники Kaiten</summary><p>Загрузка доступна после отдельного применения миграции 002.</p><form action="/app/analytics/enrichment-migration" method="post"><button class="button" name="action" value="prepare">Проверить готовность миграции 002</button></form></details>';
 const {stages,running,disk,ids,verification,property,pilotMeasurement}=state;
 const next=steps.find(step=>stages[step]?.state!=="done");
 const action=(value,label)=>`<button type="submit" class="button" name="action" value="${value}">${label}</button>`;
 return `<details class="card" id="kaiten-enrichment"${Object.keys(stages).length?" open":""}>
 <summary><strong>Дополнительные источники Kaiten</strong></summary>
 <p>Выполняйте этапы по порядку. Можно закрыть вкладку. После перезапуска продолжайте прерванный этап.</p>
 <p>Объём базы ${Math.ceil(disk.database/1048576)} МиБ, таблицы дополнений ${Math.ceil(disk.extra/1048576)} МиБ.
 Свободное место тома проверяется в Railway Metrics.</p>
 ${ids.length?`<p>Карточек в пробе: ${ids.length}.</p>`:""}
 ${pilotMeasurement?`<p>Проба: ${pilotMeasurement.cards} карточек, ${pilotMeasurement.requests} запросов Kaiten, рост таблиц на
 ${Math.ceil(pilotMeasurement.bytes/1024)} КиБ. Оценка по пробе для карточек — около ${pilotMeasurement.expectedRequests} запросов.
 Авторы, дополнительные страницы и повторы могут увеличить итог.</p>`:""}
 <p><a href="/app/analytics#kaiten-enrichment">Обновить статус</a></p>
 ${steps.map((kind,index)=>{
  const stage=stages[kind];
  const eligible=!running&&(kind===next||stage?.state==="done");
  const hasWrites=!["verify","activity","final"].includes(kind);
  const interrupted=stage?.state==="running"&&running!==kind;
  return `<details${kind===next||running===kind?" open":""}><summary><strong>${index+1}. ${titles[kind]}</strong> · ${interrupted?"Прервано":labels[stage?.state]??"Ожидает"}</summary>
   ${stage?`<p>Обработано ${stage.processed}${stage.expected? " · объём выборки "+stage.expected:""}. Ошибок ${stage.errors}. Последний успех ${escape(format(stage.lastSuccess))}.</p>`:""}
   ${stage?.reason?`<p>${escape(stage.reason)}</p>`:""}
   ${kind==="verify"&&verification?.kind==="verify"||kind==="final"&&verification?.kind==="final"?`<div class="tablewrap"><table><thead><tr><th>Источник</th><th>Успешно</th><th>Всего</th><th>Текущие ошибки</th><th>Последний успех</th></tr></thead><tbody>
    ${verification.rows.map(row=>`<tr><td>${escape(row.source)}</td><td>${row.done}</td><td>${row.total}</td><td>${row.errors}</td><td>${escape(format(row.last))}</td></tr>`).join("")}
    </tbody></table></div><p>Автор заполнен у ${verification.history.authors} из ${verification.history.events} событий. Проверено карточек ${verification.history.checked}.</p>`:""}
   ${kind==="dictionaries"&&property.length?`<details><summary>Поле 428033 · название и варианты</summary>
    <ul>${property.map(row=>`<li>${escape(row.entity_id)} · ${escape(row.label??"—")}${row.type?" · "+escape(row.type):""}</li>`).join("")}</ul>
    ${property[0].total>property.length?"Показаны первые 100 записей.":""}</details>`:""}
   ${eligible?`<form action="/app/analytics/enrichment" method="post" class="report-filters"><input type="hidden" name="kind" value="${kind}">
    ${hasWrites?'<label>Свободно на томе PostgreSQL, МиБ<input required type="number" inputmode="numeric" name="free" min="128" max="1000000"></label>':""}
    ${["detail","comments","relations","blockers","authors"].includes(kind)?'<label><input type="checkbox" name="reviewed" value="yes" required> Проверены объём пробы, свободное место и нагрузка.</label>':""}
    ${!stage?action("start","Запустить"):
      interrupted||["stopped","failed"].includes(stage.state)?action("resume","Продолжить"):
      hasWrites&&stage.errors?action("retry","Повторить ошибки"):!hasWrites?action("start","Проверить снова"):""}
    ${stage&&kind==="verify"&&stage.state==="failed"?action("start","Проверить снова"):""}
   </form>`:""}
   ${running===kind?`<form action="/app/analytics/enrichment" method="post"><input type="hidden" name="kind" value="${kind}">${action("stop","Остановить")}</form>`:""}
   </details>`;
 }).join("")}
 </details>`;
}
