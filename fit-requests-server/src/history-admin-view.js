const date = new Intl.DateTimeFormat("ru-RU",{
 dateStyle:"short",timeStyle:"medium",timeZone:"Asia/Novosibirsk"
});
const states = {running:"Выполняется",done:"Завершено",stopped:"Остановлено",failed:"Требуется внимание"};
const kinds = {check:"Проверка готовности",trial:"Пробная загрузка",pending:"Загрузка истории"};
const mib = bytes => Math.round(bytes / 1024 / 1024) + " МиБ";
const duration = ms => (ms / 1000).toFixed(1) + " с";
const progress = row => row
 ? `Карточек обработано ${row.processed} из ${row.selected}. Получено событий ${row.received}, добавлено ${row.inserted}. Ошибки API ${row.error}, недоступно ${row.forbidden + row.not_found}.`
 : "Подготовка…";

export function historyAdminPanel({counts,ready,trial,fresh,job},escape) {
 const running = job?.state === "running";
 const loading = running && job.kind !== "check";
 const action = (value,label,enabled) => `<button class="button" type="submit" name="action" value="${value}"${enabled ? "" : ' disabled style="opacity:.55"'}>${label}</button>`;
 const totals = counts && [
  ["Карточек в базе",counts.cards],["Карточек с загруженной историей",counts.loaded],
  ["Исторических событий",counts.events],["Карточек без попытки загрузки",counts.pending],
  ["Ошибки и недоступные карточки",counts.errors],
  ["Последняя успешная загрузка",counts.lastSuccess ? date.format(new Date(counts.lastSuccess)) + " НСК" : "Нет"]
 ];
 const pendingEnabled = !running && fresh && trial?.passed;
 return `<section class="card" id="history-sync">
  <h2>Синхронизация истории Kaiten</h2>
  ${totals ? `<dl>${totals.map(([label,value])=>`<div style="display:flex;gap:8px;justify-content:space-between;border-bottom:1px solid #eef0f3;padding:5px 0"><dt>${escape(label)}</dt><dd style="margin:0;text-align:right">${escape(value)}</dd></div>`).join("")}</dl>` : "<p>Счётчики временно недоступны.</p>"}
  <p><strong>Статус</strong> ${job ? escape(kinds[job.kind] + " · " + (job.stop && running ? "Остановка после текущих карточек" : states[job.state])) : "Ожидает запуска"}</p>
  ${job?.kind !== "check" && job?.progress ? `<p>${job.kind === "trial" ? "Проход " + job.phase + ". " : ""}${escape(progress(job.progress))}</p>
   <progress aria-label="Прогресс загрузки" value="${job.progress.processed}" max="${Math.max(1,job.progress.selected)}" style="width:100%"></progress>` : ""}
  ${job?.message ? "<p>" + escape(job.message) + (job.errorStatus ? " HTTP " + escape(job.errorStatus) + "." : "") + "</p>" : ""}
  ${ready ? `<p>Таблицы, индексы и API Kaiten доступны. При проверке было ${ready.counts.cards} карточек и ${ready.counts.events} событий. Размер БД ${mib(ready.databaseBytes)}. Свободно в контейнере приложения ${mib(ready.freeBytes)}. ${fresh ? "" : "Срок проверки истёк. Повторите её."}</p>` : ""}
  ${trial ? `<p><strong>Пробная партия ${trial.passed ? "прошла" : "не прошла"}</strong> · ${duration(trial.duration)}</p>
   <p>Первый проход. ${escape(progress(trial.first))}</p>
   ${trial.repeat ? "<p>Повторный проход. " + escape(progress(trial.repeat)) + "</p>" : ""}` : ""}
  <form action="/app/analytics/history" method="post" class="report-filters">
   ${action("check","Проверить готовность",!running)}
   ${action("trial","Пробная загрузка",!running && fresh)}
   ${action("stop","Остановить загрузку",loading && !job.stop)}
  </form>
  ${pendingEnabled ? `<form action="/app/analytics/history" method="post" style="margin-top:14px">
   <label style="display:flex;gap:8px;margin-bottom:8px"><input type="checkbox" name="volumeChecked" value="yes" required>
   <span>Проверено свободное место на томе PostgreSQL и отсутствие высокой нагрузки в Railway → Metrics.</span></label>
   ${action("pending","Загрузить историю",true)}
  </form>` : `<p>${action("pending","Загрузить историю",false)}</p>`}
  <p>Можно закрыть страницу во время загрузки. После остановки повторный запуск продолжит с ожидающих карточек.</p>
  <a href="/app/analytics#history-sync" id="history-progress-refresh">Обновить статус</a>
 </section>`;
}
