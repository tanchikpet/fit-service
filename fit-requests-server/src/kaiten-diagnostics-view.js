import ExcelJS from "exceljs";

const missing = "Нет данных";
const value = item => item ?? missing;
const displayDate = input => !input ? missing : new Intl.DateTimeFormat("ru-RU",{
 dateStyle:"short",timeStyle:"short",timeZone:"Asia/Novosibirsk"
}).format(new Date(input))+" НСК";

const notes = [
 ["Объём","Диагностика читает сохранённую выборку WEB. API проверяется на трёх карточках, ограниченных окнах и страницах. Максимум 70 GET, 7 секунд на запрос и 120 секунд на этап API."],
 ["Заполненность","Ноль учитывается отдельно и входит в процент непустых значений. False — значение. Используются ключи верхнего уровня JSON и числовые ID пользовательских полей. Вложенные списки профилируются как массивы, без выгрузки содержимого."],
 ["Недоступность","403 означает недостаток доступа. 404 может означать отсутствие или скрытый ресурс. 405/501 означают неподдерживаемый метод. Пустой результат относится к конкретному запросу."],
 ["История","Категории активности определяются по именам событий и полям изменений. Нулевой счётчик означает, что признак не встретился в проверенной выборке."],
 ["Колонки","Даты показывают первое и последнее наблюдение в БД. Названия из текущего API не доказывают историческое название, назначение или период. Произвольные названия скрываются для защиты персональных данных."],
 ["Вебхуки","Текущий вебхук запускает перечитывание карточек и не хранит изменения. Для будущей истории проверить состав old/new и идентификаторы доставок, затем сохранять выбранные изменения и сверять с текущим API."],
 ["Собирать с текущего момента","Снимки и изменения сроков, ответственных, оценок, типов, приоритетов и свойств. Отдельно сохранять связи, снятие блокировок и версии структуры WEB, если лента не покрывает необходимые события."],
 ["Расширение синхронизации","Начать со справочников типов, ролей и пользовательских полей, подтверждённых запросами. Раздельно учитывать права, пустые данные и ограничения пагинации. Не копировать тела комментариев и профили пользователей."]
];

function sections(report) {
 return [
  ["Сводка",["Параметр","Значение"],[
   ["Диагностика",displayDate(report.generatedAt)],["Карточки",report.summary.cards],
   ["Истории с успешной загрузкой",report.summary.histories],["События перемещений",report.summary.events],
   ["Самая ранняя подтверждённая активность",displayDate(report.earliest.observed)],
   ["Граница поиска от",displayDate(report.earliest.lower)],["Граница поиска до",displayDate(report.earliest.upper)],
   ["Ограничение",report.earliest.note],
   ["Проверок API выполнено",report.coverage.checked],["Из них с ошибкой",report.coverage.failed],
   ["Проверок API пропущено",report.coverage.skipped]]],
  ["Поля",["Источник","Поле или ID","Карточек","Ключ есть","Ключ отсутствует","Null","Пусто","Ноль","Заполнено без нулей","Заполненность, %","Типы","Форматы","Неоднородное","Тип свойства Kaiten"],
   report.fields.map(f=>[f.scope,f.field,f.total,f.present,f.total-f.present,f.null,f.empty,f.zero,f.filled,
    f.total ? Number(((f.filled+f.zero)/f.total*100).toFixed(1)) : missing,value(f.types),value(f.formats),f.mixed?"Да":"Нет",value(f.definition)])],
  ["Единицы оценок",["Единица","Числовых оценок"],report.units.map(x=>[x.unit,x.cards])],
  ["Проверки API",["Проверка","Метод GET","HTTP","Попытка","Результат","Объектов","Обёртка","Ключи обёртки","Ключи записей","Отдельные поля","Есть следующий курсор","Раннее наблюдение","Позднее наблюдение","Ограничения"],
   report.probes.map(p=>[p.name,p.endpoint,value(p.status),p.attempted?"Выполнена":"Пропущена",p.result,value(p.count),value(p.shape),p.envelope??"",p.keys??"",
    p.fields?.join("; ")??"",p.hasNext?"Да":p.hasNext===false?"Нет или не предусмотрен":missing,displayDate(p.earliest),displayDate(p.latest),p.note])],
  ["Справочники",["Источник","Записей в ответе"],report.dictionaries.map(d=>[d.name,value(d.count)])],
  ["Исторические изменения",["Категория","Событий с признаками","Явные пары до и после","Проверенные окна с совпадениями"],
   report.activity.map(a=>[a.category,a.events,a.beforeAfter,a.windows])],
  ["Колонки",["ID доски","ID колонки","Первое событие","Последнее событие","Событий","Текущее название","Статус названия","Текущий тип","Историческое название","Назначение","Подтверждённый период"],
   report.columns.map(c=>[c.board,c.column,displayDate(c.first),displayDate(c.last),c.events,value(c.currentName),c.nameStatus,
    value(c.currentType),value(c.historicalName),value(c.processStage),value(c.validity)])],
  ["Ограничения и рекомендации",["Тема","Описание"],notes]
 ];
}

export function diagnosticsPanel(status,escape) {
 const {report,running,error} = status;
 return `<details class="card" id="kaiten-diagnostics"${report||running||error?" open":""}>
 <summary><strong>Диагностика данных Kaiten</strong></summary>
 <p>Проверяет сохранённые карточки WEB и ограниченную выборку API. Записи в PostgreSQL и Kaiten не выполняются.</p>
 <form action="/app/analytics/diagnostics" method="post">
  <button class="button" type="submit"${running?" disabled":""}>Запустить диагностику</button>
 </form>
 ${running?'<p>Выполняется. Можно закрыть вкладку.</p><p><a href="/app/analytics#kaiten-diagnostics">Обновить статус</a></p>':""}
 ${error?'<p>Последняя попытка не завершена. Повторите проверку позже.</p>':""}
 ${report?`<p>${report.coverage.skipped||report.coverage.failed?"Проверка завершена частично":"Готово"} · ${escape(displayDate(report.generatedAt))}</p><p><a class="button" href="/api/analytics/diagnostics.xlsx">Скачать диагностику Excel</a></p>
 ${sections(report).map(([title,headers,rows])=>`<details${title==="Сводка"?" open":""}><summary>${escape(title)}</summary>
 ${rows.length?`<div class="tablewrap"><table><thead><tr>${headers.map(h=>`<th scope="col">${escape(h)}</th>`).join("")}</tr></thead>
 <tbody>${rows.map(row=>`<tr>${row.map(x=>`<td>${escape(x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`:"<p>Нет строк.</p>"}</details>`).join("")}`:""}
 </details>`;
}

export async function diagnosticsWorkbook(report) {
 const workbook = new ExcelJS.Workbook();
 for (const [name,headers,rows] of sections(report)) {
  const sheet = workbook.addWorksheet(name,{views:[{state:"frozen",ySplit:1}]});
  sheet.addRow(headers).font = {bold:true};
  for (const row of rows) sheet.addRow(row);
  for (const column of sheet.columns) {
   column.width = Math.max(18,Math.min(62,headers[column.number-1].length+12));
   column.alignment = {vertical:"top",wrapText:true};
  }
  if (rows.length) sheet.autoFilter={from:{row:1,column:1},to:{row:1,column:headers.length}};
 }
 return workbook.xlsx.writeBuffer();
}
