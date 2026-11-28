function table(columns,rows,escape){
 return '<div class="tablewrap"><table><thead><tr>'+columns.map(cell=>'<th>'+escape(cell)+'</th>').join("")+
 '</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(cell=>'<td>'+escape(cell??"—")+'</td>').join("")+'</tr>').join("")+
 '</tbody></table></div>';
}
export function targetedActivityPanel({report,running,failed},escape){
 const status=running?'Проверка выполняется. <a href="/app/analytics#targeted-activity">Обновить статус</a>':
  failed?"Проверку завершить не удалось.":report?"Проверка завершена.":"Проверка ещё не запускалась.";
 return `<details class="card" id="targeted-activity"${report||running||failed?" open":""}><summary><strong>Целевая проверка активности Kaiten</strong></summary>
 <p>Проверка только на чтение. Фильтрация API проверяется по actions. Совпадение по сущностям оценивается локально, поскольку для них не документирован отдельный фильтр.</p>
 <p>${status}</p>${report?`
 <p>Запросов ${report.requests}. Действия для пробы являются кандидатами. Пропуск или пустой результат не подтверждают отсутствие истории.</p>
 <h3>Ответы API</h3>
 ${table(["Год","Группа","Запрошенные действия","Полученные действия","HTTP","Страниц","Событий","Совпало","Иные действия","Совпадения по ID","Ограничения"],
 report.probes.map(x=>[x.year,x.label,x.filter,x.actions.join(", "),x.status,x.pages,x.items,x.matched,x.other,x.entityMatches,x.causes.join(" ")]),escape)}
 <h3>Признаки изменений в выборке</h3>
 ${table(["Событие","Дата UTC","Действие","Карточки","Колонки","Доски","ID сущности","ID автора","Поля с парой до и после"],
 report.evidence.map(x=>[x.id,x.dated,x.action,x.cards.join(", "),x.columns.join(", "),x.boards.join(", "),x.entities.join(", "),x.author,x.fields.join(", ")]),escape)}
 <h3>Имена и типы, найденные в событиях колонок</h3>
 ${report.names.length?table(["Колонка","Дата UTC","Имя до","Имя после","Тип до","Тип после"],
 report.names.map(x=>[x.column,x.date,x.oldName,x.newName,x.oldType,x.newType]),escape):"<p>В выборке подтверждений нет.</p>"}
 <h3>Доска 898832 · маршруты для подтверждения</h3>
 <p>Предыдущая и следующая позиции относятся к соседним сохранённым сменам позиции. Они не устанавливают назначения колонки. Для каждой карточки взято первое появление в колонке.</p>
 ${table(["Колонка","Предыдущая доска / колонка","Следующая доска / колонка","Карточек в маршруте","Примеры ID","Назначение"],
 report.columns.flatMap(id=>{
  const rows=report.routes.filter(x=>x.column_id===id);
  return rows.length?rows.map(x=>[id,[x.previous_board,x.previous_column].filter(Boolean).join(" / "),
   [x.next_board,x.next_column].filter(Boolean).join(" / "),x.cards,x.examples.join(", "),"Подтвердить"]):
   [[id,null,null,0,null,"Подтвердить"]];
 }),escape)}`:""}</details>`;
}
