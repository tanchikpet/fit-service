const format=value=>value?new Intl.DateTimeFormat("ru-RU",{
 dateStyle:"short",timeStyle:"short",timeZone:"Asia/Novosibirsk"
}).format(new Date(value)):"—";
const reasonLabel={401:"Проверьте токен Kaiten",403:"Систематический отказ в доступе",429:"Ограничение частоты Kaiten",budget:"Исчерпан лимит запросов партии",error:"Ошибка обработки партии",resource_limit:"Пауза по лимиту размера базы или нагрузки"};
const axes={board:"Доска",type:"Тип",priority:"RR Приоритет",members:"С участниками"};
const priorityLabels={"218940":"High","218941":"Medium","218942":"Low","∅":"Без значения"};
const historicalColumns=[3189877,3189965,3189878,3189992,3189879];

export function reliabilityPanel(state,coverage,escape){
 const {run}=state;
 const authors=coverage?.authors;
 const checks=coverage?.sources?.filter(row=>row.source==="checklists")??[];
 const unresolved=checks.filter(row=>row.result==="error"&&row.http_status===200).reduce((sum,row)=>sum+row.total,0);
 const failures=coverage?.sources?.filter(row=>["error","not_found","forbidden"].includes(row.result)&&row.http_status!==200)
  .reduce((sum,row)=>sum+row.total,0)??0;
 return `<section class="card" id="kaiten-sync"><h2>Синхронизация Kaiten</h2>
 <p>${state.available?(run?.outcome?.paused?escape(reasonLabel[run.outcome.paused]??"Пауза"):
  state.busy?"Выполняется партия":run?.finished_at?"Контрольный проход завершён":run?"Проход ожидает следующую партию":"Ожидает запуска"):"Требуется миграция 003"}</p>
 <p>Последний успешный проход ${format(run?.last_success_at)} · Следующий плановый ${state.enabled?format(state.next):"расписание выключено"}</p>
 ${coverage?`<p>Карточек в базе ${coverage.cards} · Авторов перемещений ${authors.withAuthor} из ${authors.total} · Ошибок источников ${failures} · Поле чек-листов недоступно ${unresolved}</p>`:""}
 ${state.available&&state.resourceLimit?`<form method="post" action="/app/analytics/kaiten-sync"><button class="button">Обновить вручную</button></form>`:""}
 ${!coverage?"<p>Контрольные агрегаты пока недоступны.</p>":""}
 ${state.available&&!state.resourceLimit?"<p>Перед запуском задайте лимит размера базы.</p>":""}
 ${coverage?`<details><summary>Техническая диагностика и полнота данных</summary>
 <p>Карточек с HTTP 403 одновременно по семи источникам — ${coverage.common_forbidden}. Из них с HTTP 403 при чтении истории — ${coverage.common_forbidden_with_history}.</p>
 <p>История сохранена у ${coverage.history.cards} карточек. Старым загрузчиком авторов проверено ${coverage.history.legacyAuthorCards} карточек.</p>
 <p>Авторы событий: явно отсутствуют — ${authors.noAuthor}, поле отсутствует в ответе — ${authors.fieldMissing},
  событие ещё не проверено — ${authors.unprocessed}, последняя загрузка истории завершилась ошибкой — ${authors.failed} непроверенных событий.</p>
 <p>Связи в основном JSON: повторяющиеся ID — ${coverage.repeated_relation_ids}, ссылки на себя — ${coverage.self_relations},
  ссылки за пределы сохранённой выборки — ${coverage.external_relation_ids}.</p>
 <p>Заполнено: тип — ${coverage.fields.types}, срок — ${coverage.fields.due}, оценка — ${coverage.fields.estimate},
  владелец — ${coverage.fields.owners}, участники — ${coverage.fields.members}, RR Приоритет — ${coverage.fields.priority} (${coverage.cards?(coverage.fields.priority*100/coverage.cards).toFixed(1):"—"}%).</p>
 <table><thead><tr><th>Источник</th><th>Результат</th><th>HTTP</th><th>Объектов</th><th>Со снимком</th></tr></thead><tbody>
 ${(coverage.sources??[]).map(row=>`<tr><td>${escape(row.source)}</td><td>${escape(row.result==="error"&&row.http_status===200?"Поле недоступно":row.result)}</td><td>${row.http_status??"—"}</td><td>${row.total}</td><td>${row.saved}</td></tr>`).join("")}
 </tbody></table>
 <table><thead><tr><th>Срез</th><th>Значение</th><th>Карточек</th></tr></thead><tbody>
 ${(coverage.distributions??[]).map(row=>`<tr><td>${escape(axes[row.axis])}</td><td>${escape(priorityLabels[row.key?.replaceAll('"','')]??row.key??"—")}</td><td>${row.total}</td></tr>`).join("")}
 </tbody></table>
 <details><summary>Нагрузка по участникам без имён</summary><ul>
 ${(coverage.participant_load??[]).map(row=>`<li>Карточек на участника — ${row.cards_per_participant}. Таких участников — ${row.participants}.</li>`).join("")}
 </ul></details>
 <details><summary>Приоритет по году создания, текущей доске и типу</summary>
 <table><thead><tr><th>Год</th><th>Доска</th><th>Тип</th><th>Приоритет</th><th>Карточек</th></tr></thead><tbody>
 ${(coverage.priority_by_group??[]).map(row=>`<tr><td>${row.year}</td><td>${escape(row.board_id??"—")}</td><td>${escape(row.type??"—")}</td><td>${escape(priorityLabels[row.rr??"∅"]??JSON.stringify(row.rr))}</td><td>${row.total}</td></tr>`).join("")}
 </tbody></table></details>
 <p>Подтверждения владельца процесса ждут колонки доски 898832: ${historicalColumns.join(", ")}.
  Расчёт выполнения и KPI недоступен. Данные отражают сохранённую выборку.</p></details>`:""}</section>`;
}
