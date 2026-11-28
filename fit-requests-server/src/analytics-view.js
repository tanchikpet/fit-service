import ExcelJS from "exceljs";
import {TIME_ZONE} from "./analytics.js";

const noData = "Нет данных";
const format = new Intl.DateTimeFormat("ru-RU",{
 timeZone:TIME_ZONE,dateStyle:"medium",timeStyle:"short"
});
const at = date => date ? format.format(date) + " НСК" : noData;
const value = field => field ?? noData;

function tables(report) {
 const {coverage} = report;
 const boardName = id => report.boards.find(board => board.id === id)?.label ?? noData;
 return [
  {name:"По месяцам", columns:["Месяц (НСК)","Создано","Первое поступление на доску","Месяц"],
   rows:report.months.map(row => [row.month,value(row.created),value(row.arrivals),row.partial ? "Неполный" : "Завершённый"])},
  {name:"Текущий состав", columns:["Доска","ID доски","ID колонки","Статус / этап","State Kaiten","Condition Kaiten","Карточек"],
   rows:report.statuses.map(row => [boardName(row.board),value(row.board),value(row.column),row.status,value(row.state),value(row.condition),row.count])},
  {name:"Охват и актуальность", columns:["Показатель","Значение"], rows:[
   ["Карточек в выборке для истории",coverage.total],
   ["История успешно получена хотя бы раз",coverage.successful],
   ["Последняя попытка — получены события",coverage.loaded],
   ["Последняя попытка — пустая история",coverage.empty],
   ["Последняя попытка — нет доступа (403)",coverage.forbidden],
   ["Последняя попытка — карточка недоступна (404)",coverage.not_found],
   ["Последняя попытка — прочие ошибки",coverage.error],
   ["Загрузка ещё не выполнялась",coverage.pending],
   ["Ранее загруженные истории, требующие обновления",coverage.stale],
   ["Самая ранняя успешная загрузка среди карточек",at(coverage.oldestSuccessAt)],
   ["Самая свежая успешная загрузка среди карточек",at(coverage.latestSuccessAt)],
   ["Последняя успешная синхронизация текущих карточек",at(report.currentAsOf)],
   ["Синхронизация текущих карточек",report.syncFailed ? "Последняя попытка завершилась ошибкой" : report.currentAsOf ? "Успешно" : noData],
   ["Карточки с неизвестным наличием родителя до фильтрации",coverage.unknownParents],
   ["Карточки без даты создания в текущем срезе",coverage.unknownCreated]
  ]},
  {name:"Неподтверждённые колонки", columns:["Доска события","ID доски","ID колонки","Событий за период"],
   rows:report.unconfirmed.map(row => [boardName(row.board),value(row.board),value(row.column),row.count])},
  {name:"Методология", columns:["Параметр","Описание"], rows:[
   ["Период",report.filters.from + " — " + report.filters.to],
   ["Доска",report.filters.board ? boardName(report.filters.board) + " (" + report.filters.board + ")" : "Все"],
   ["Родитель сейчас",parentLabels[report.filters.parent]],
   ["Часовой пояс",report.timeZone],
   ["Версия справочника этапов",report.dictionaryVersion],
   ...report.methodology.map((item,index) => ["Правило " + (index+1),item])
  ]}
 ];
}

const parentLabels = {all:"Все",yes:"С родителем",no:"Без родителя"};

export function analyticsPage(report, escape, historyPanel = "") {
 const {filters} = report;
 const option = (id,label,selected) =>
  `<option value="${escape(id)}"${id === selected ? " selected" : ""}>${escape(label)}</option>`;
 const query = new URLSearchParams(filters);
 const sections = tables(report).slice(0,4).map(table => `<section class="card"><h2>${escape(table.name)}</h2>
   ${table.rows.length ? `<div class="tablewrap"><table><thead><tr>${table.columns.map(column =>
    "<th scope=\"col\">" + escape(column) + "</th>").join("")}</tr></thead><tbody>${table.rows.map(row =>
    "<tr>" + row.map(cell => "<td>" + escape(cell) + "</td>").join("") + "</tr>").join("")}</tbody></table></div>` : "<p>Нет строк в выбранном срезе.</p>"}
   </section>`).join("");
 return `<header><a class="logo" href="/app"><img src="/ui/brand-dark.svg?v=brand-3" alt="FIT Requests"></a>
  <a href="/app">К заявкам</a></header>
  <main><h1>Аналитика Kaiten</h1>${historyPanel}
  <p>Сохранённая выборка FIT Requests. Последняя успешная синхронизация карточек — ${escape(at(report.currentAsOf))}.</p>
  <section class="card"><form class="report-filters" action="/app/analytics" method="get">
   <label>Начало периода <input type="month" name="from" value="${escape(filters.from)}" required></label>
   <label>Конец периода <input type="month" name="to" value="${escape(filters.to)}" required></label>
   <label>Доска <select name="board">${option("","Все доски",filters.board)}${report.boards.map(board =>
    option(board.id,board.label + " · " + board.id,filters.board)).join("")}</select></label>
   <label>Наличие родителя сейчас <select name="parent">${Object.entries(parentLabels).map(([id,label]) =>
    option(id,label,filters.parent)).join("")}</select></label>
   <button class="button" type="submit">Показать</button>
   <a class="button" href="/api/analytics.xlsx?${escape(query.toString())}">Скачать Excel</a>
  </form>
  <p>Фильтр доски использует текущий снимок для созданий и состава, исторический ID для поступлений. Фильтр родителя всегда использует текущий снимок.</p>
  ${filters.board ? "" : "<p>Выберите доску, чтобы увидеть первые поступления на неё.</p>"}
  </section>
  ${sections}
  <details class="card"><summary>Как рассчитан отчёт</summary><ul>${report.methodology.map(item =>
   "<li>" + escape(item) + "</li>").join("")}</ul><p>Версия справочника этапов — ${escape(report.dictionaryVersion)}.</p></details></main>`;
}

export async function analyticsWorkbook(report) {
 const workbook = new ExcelJS.Workbook();
 for (const table of tables(report)) {
  const sheet = workbook.addWorksheet(table.name,{views:[{state:"frozen",ySplit:1}]});
  sheet.addRow(table.columns).font = {bold:true};
  for (const values of table.rows) sheet.addRow(values);
  for (const column of sheet.columns) {
   column.width = table.name === "Методология" && column.number === 2 ? 105 :
    Math.min(62,Math.max(14,table.columns[column.number - 1].length + 2));
   column.alignment = {wrapText:true,vertical:"top"};
  }
  if (table.name === "Методология") {
   sheet.eachRow(row => { if (row.number > 1) row.height = 48; });
  }
 }
 return workbook.xlsx.writeBuffer();
}
