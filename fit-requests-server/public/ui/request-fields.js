export const requestKinds = {new: 'Новая акция', update: 'Обновление акции', other: 'Другое'};
// One field definition for the form, server validation and Kaiten description.
export const requestFields = [
 ['title','Название задачи','text','all',true,150],
 ['owner','Ответственный','text','all',true,120],
 ['plannedUrl','Планируемый адрес','url','new',true,2048],
 ['actualUrl','Адрес','url','update other',true,2048],
 ['description','Описание задачи','textarea','all',true,10000],
 ['sourceId','id источника','text','new',true,120],
 ['promoCode','Промо-код','text','new',false,500],
 ['cardRange','Диапазон карт','text','new',false,1000],
 ['campaignId','ID кампании в ЗС','text','new',false,200],
 ['offer','Оффер','textarea','new update',true,4000],
 ['campaignStart','Начало акции','date','new update',true,10],
 ['campaignEnd','Окончание акции','date','new update',true,10],
 ['stations','Для каких станций','textarea','new',true,4000],
 ['terms','Условия акции','textarea','new update',true,10000],
 ['restrictions','Ограничения акции','textarea','new update',true,10000],
 ['otherPromotions','Блок Другие Акции','textarea','new update',true,4000],
 ['counter','Счетчик','textarea','new',true,1000],
 ['campaignGoals','Цели Акции','textarea','new',true,4000],
 ['materials','Ссылка на материалы','url','all',false,2048],
 ['goal','Ожидаемый результат','textarea','all',false,4000],
 ['desiredDue','Желаемый срок','date','all',false,10],
 ['express','Чат проекта','url','all',false,2048]
];
export const activeFields = kind => requestFields.filter(([, , , kinds]) => kinds === 'all' || kinds.split(' ').includes(kind));
export const fieldLabel = (field, kind) => field[0] === 'actualUrl' && kind === 'other' ? 'Ссылка на сайт или страницу' : field[1];
export function validateRequestFields(payload, {draft = false} = {}) {
 if (!Object.hasOwn(requestKinds, payload.requestKind)) return {key:'requestKind',message:'Выбери тип заявки'};
 for (const field of activeFields(payload.requestKind)) {
  const [key,,type,,required,max] = field, value = payload[key];
  if (value != null && (typeof value !== 'string' || value.length > max)) return {key,message:'Неверное поле: '+fieldLabel(field,payload.requestKind)};
  if (!draft && required && !value?.trim()) return {key,message:'Заполни поле «'+fieldLabel(field,payload.requestKind)+'»'};
  if (!value) continue;
  if (type === 'url') {try {const u = new URL(value); if (!['https:','http:'].includes(u.protocol)||u.username||u.password) throw Error();} catch {return {key,message:'Проверь ссылку в поле «'+fieldLabel(field,payload.requestKind)+'»: нужен адрес http:// или https://'};}}
  if (type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value)) return {key,message:'Проверь дату в поле «'+fieldLabel(field,payload.requestKind)+'»'};
 }
 if (payload.requestKind !== 'other' && payload.campaignStart && payload.campaignEnd && payload.campaignStart > payload.campaignEnd) return {key:'campaignEnd',message:'Окончание акции не может быть раньше ее начала'};
 return null;
}
