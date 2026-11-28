import {readFileSync} from "node:fs";

const stages = JSON.parse(readFileSync(new URL("./kaiten-process.json",import.meta.url),"utf8")).stages;
const expected = ("id uid title created updated archived state condition board_id column_id subcolumn_id lane_id " +
 "description description_filled due_date due_date_time_present planned_start planned_end calculated_planned_start calculated_planned_end " +
 "completed_at completed_on_time last_moved_at first_moved_to_in_progress_at last_moved_to_done_at last_moved_to_in_progress_at " +
 "owner_id updater_id members type_id tag_ids asap priority properties size size_unit size_text estimate_workload " +
 "time_spent_sum time_blocked_sum blocked blockers comments_total comment_last_added_at checklists children_ids parents_ids " +
 "children_count parents_count children_done goals_total goals_done external_id sprint_id external_links files").split(" ");
const PREFIX = "/api/latest";
const DAY = 86400000;
const SAFE_KEY = /^[a-zA-Z_][a-zA-Z_0-9:-]{0,90}$/;
const ID = /^[1-9]\d{0,17}$/;
const publicColumnNames = new Set(["Очередь","В работе","Тестирование","Готово","Демо","Анализ","Пауза","Согласование"]);
const time = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) &&
 Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const numericId = value => ID.test(String(value ?? "")) ? String(value) : null;
const uuid = value => typeof value === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value) ? value : null;
const customKey = value => typeof value === "string" && /^(?:id_)?[1-9]\d{0,17}$/.test(value) ? value.replace(/^id_/,"") : null;

const profileSql = `WITH source AS MATERIALIZED (
 SELECT c.data, to_jsonb(c)-'data' AS columns FROM kaiten_cards c WHERE c.space_id=$1
), fields AS (
 SELECT 'JSON' AS scope,k,v FROM source, LATERAL jsonb_each(CASE WHEN jsonb_typeof(data)='object' THEN data ELSE '{}' END) e(k,v)
 WHERE k ~ '^[a-zA-Z_][a-zA-Z_0-9]{0,90}$'
 UNION ALL
 SELECT 'PostgreSQL',k,v FROM source, LATERAL jsonb_each(columns) e(k,v)
 UNION ALL
 SELECT 'Свойство',regexp_replace(k,'^id_',''),v FROM source,
 LATERAL jsonb_each(CASE WHEN jsonb_typeof(data->'properties')='object' THEN data->'properties' ELSE '{}' END) e(k,v)
 WHERE k ~ '^(id_)?[1-9][0-9]{0,17}$'
), classified AS (
 SELECT scope,k,jsonb_typeof(v) AS kind,
 CASE WHEN v='null' THEN 'null'
      WHEN v IN ('[]','{}') OR (jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^[[:space:]]*$') THEN 'empty'
      WHEN v='0' THEN 'zero' ELSE 'filled' END AS state,
 CASE WHEN jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^[+-]?[0-9]+([.,][0-9]+)?$' THEN 'число в строке'
      WHEN jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN 'дата и время'
      WHEN jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN 'дата'
      WHEN jsonb_typeof(v)='string' THEN 'прочая строка' ELSE jsonb_typeof(v) END AS format
 FROM fields
)
 SELECT scope,k AS field,(SELECT count(*)::int FROM source) AS total,
 count(*)::int AS present,count(*) FILTER(WHERE state='null')::int AS "null",
 count(*) FILTER(WHERE state='empty')::int AS empty,
 count(*) FILTER(WHERE state='zero')::int AS zero,
 count(*) FILTER(WHERE state='filled')::int AS filled,
 string_agg(DISTINCT kind,', ' ORDER BY kind) AS types,
 string_agg(DISTINCT format,', ' ORDER BY format) FILTER(WHERE state NOT IN ('null','empty')) AS formats,
 count(DISTINCT format) FILTER(WHERE state NOT IN ('null','empty'))>1 AS mixed
 FROM classified GROUP BY scope,k ORDER BY scope,k`;

export async function diagnosticSnapshot(pool,spaceId) {
 const db = await pool.connect();
 try {
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await db.query("SET LOCAL statement_timeout='12s'");
  const {rows:fields} = await db.query(profileSql,[spaceId]);
  const {rows:units} = await db.query(`SELECT
   CASE WHEN estimate_unit IS NULL OR btrim(estimate_unit)='' THEN 'отсутствует'
        WHEN lower(estimate_unit) IN ('h','hr','hour','hours','m','min','minute','minutes','d','day','days','sp','story points','points','ч','мин','д','баллы')
        THEN lower(estimate_unit) ELSE 'иная единица' END AS unit, count(*)::int AS cards
   FROM kaiten_cards WHERE space_id=$1 AND (jsonb_typeof(estimate_raw)='number'
    OR (estimate_raw#>>'{}') ~ '^[+-]?[0-9]+([.,][0-9]+)?$') GROUP BY 1 ORDER BY 2 DESC`,[spaceId]);
  const {rows:samples} = await db.query(`WITH cards AS (
   SELECT id,board_id,column_id,data,archived,updated_at FROM kaiten_cards WHERE space_id=$1
  ), candidates AS (
   (SELECT *,1 AS choice FROM cards ORDER BY archived,updated_at DESC NULLS LAST,id DESC LIMIT 1)
   UNION ALL
   (SELECT *,2 FROM cards ORDER BY
    (CASE WHEN data->'properties' NOT IN ('null','{}','[]') THEN 1 ELSE 0 END +
     CASE WHEN data->'checklists' NOT IN ('null','{}','[]') THEN 2 ELSE 0 END +
     CASE WHEN data->'blocked'='true' THEN 1 ELSE 0 END) DESC, updated_at DESC NULLS LAST,id DESC LIMIT 1)
   UNION ALL
   (SELECT *,3 FROM cards ORDER BY archived DESC,updated_at DESC NULLS LAST,id DESC LIMIT 1)
  )
  SELECT id::text,board_id::text,column_id::text,data->>'uid' AS uid
  FROM (SELECT DISTINCT ON(id) * FROM candidates ORDER BY id,choice) available ORDER BY choice`,[spaceId]);
  const {rows:columns} = await db.query(`SELECT e.board_id::text AS board,e.column_id::text AS column,
   min(changed_at) AS first,max(changed_at) AS last,count(*)::int AS events
   FROM kaiten_location_events e WHERE e.space_id=$1 AND e.board_id IS NOT NULL AND e.column_id IS NOT NULL
   GROUP BY e.board_id,e.column_id ORDER BY count(*) DESC,e.board_id,e.column_id LIMIT 100`,[spaceId]);
  const {rows:[summary]} = await db.query(`SELECT
   (SELECT count(*)::int FROM kaiten_cards WHERE space_id=$1) AS cards,
   (SELECT count(*)::int FROM kaiten_location_events WHERE space_id=$1) AS events,
   (SELECT count(*)::int FROM kaiten_history_loads WHERE space_id=$1 AND last_success_at IS NOT NULL) AS histories`,[spaceId]);
  await db.query("COMMIT");
  const observed = new Set(fields.filter(row=>row.scope==="JSON").map(row=>row.field));
  for (const field of expected.filter(key=>!observed.has(key))) {
   fields.push({scope:"JSON",field,total:summary.cards,present:0,null:0,empty:0,zero:0,filled:0,types:null,formats:null,mixed:false});
  }
  return {summary,fields,units,samples,columns};
 } catch (error) {
  await db.query("ROLLBACK").catch(()=>{});
  throw error;
 } finally {db.release();}
}

function records(body) {
 if (Array.isArray(body)) return body;
 if (!body || typeof body !== "object") return [];
 for (const key of ["items","result","results","data","users","cards","time_logs","columns"]) {
  if (Array.isArray(body[key])) return body[key];
 }
 return Object.keys(body).length ? [body] : [];
}

async function readJson(response) {
 const limit = 2 * 1024 * 1024;
 const reader = response.body?.getReader();
 const chunks = [];
 let length = 0;
 if (!reader) throw new Error("empty body");
 try {
  while (true) {
   const {done,value} = await reader.read();
   if (done) break;
   length += value.byteLength;
   if (length > limit) throw new Error("response limit");
   chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
 } finally { await reader.cancel().catch(()=>{}); }
}

const historyFields = {
 "Сроки":/due_date|deadline/,
 "Ответственные":/responsible|member|assignee|owner_id/,
 "Оценки":/estimate|^size(?:_|$)/,
 "Типы и приоритеты":/type_id|priority|asap/,
 "Пользовательские поля":/custom_propert|^properties$|^id_\d+/,
 "Связи":/relation|dependen|parent|child/,
 "Блокировки":/block/,
 "Архив и восстановление":/archiv|restor|condition/,
 "Структура пространства":/column|board|lane|space/
};
const sanitizedKeys = object => object && typeof object === "object" && !Array.isArray(object)
 ? Object.keys(object).filter(key=>SAFE_KEY.test(key)).slice(0,120) : [];
function activitySummary(body,label,history,columns,from,to) {
 for (const event of records(body)) {
  const observed=time(event?.created);
  if (!observed || observed<from || observed>to) continue;
  const payloads = [event,event.data,event.payload,event.changes].filter(x=>x && typeof x==="object");
  const changed = new Set();
  const different = (before,after) => JSON.stringify(before)!==JSON.stringify(after);
  const action = typeof event.action==="string" ? event.action.toLowerCase() : "";
  for (const object of payloads) {
   const field=[object.field,object.field_name,object.property].find(key=>typeof key==="string");
   for (const pair of [["old","new"],["before","after"],["old_value","new_value"]]) {
    if (!pair.every(key=>Object.hasOwn(object,key))) continue;
    const [before,after] = pair.map(key=>object[key]);
    if (field && different(before,after)) changed.add(field);
    for (const key of sanitizedKeys(before)) {
     if (after && Object.hasOwn(after,key) && different(before[key],after[key])) changed.add(key);
    }
    if (!/^column[:_](?:update|rename)/.test(action) || before?.title===after?.title) continue;
    const board=numericId(after?.board_id ?? before?.board_id);
    const column=numericId(after?.id ?? before?.id);
    const item=columns.find(item=>item.board===board && item.column===column);
    if (!item || !publicColumnNames.has(before?.title)) continue;
    const evidence=before.title+" (до изменения "+observed+")";
    item.historicalName=[...new Set([...(item.historicalName?.split("; ") ?? []),evidence])].join("; ");
   }
  }
  for (const [category,pattern] of Object.entries(historyFields)) {
   const explicit=[...changed].some(key=>pattern.test(key));
   if (!explicit && !pattern.test(action)) continue;
   const row = history[category] ||= {events:0,beforeAfter:0,windows:new Set()};
   row.events++;
   row.beforeAfter += Number(explicit);
   row.windows.add(label);
  }
 }
}

function shape(body,items) {
 const keys = [...new Set(items.slice(0,3).flatMap(sanitizedKeys))].sort();
 return {shape:Array.isArray(body)?"массив":body===null?"null":typeof body,
  envelope:sanitizedKeys(body).sort().join(", "),keys:keys.join(", ")};
}

export async function runDiagnostics({pool,config,fetcher=fetch,now=new Date(),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
 const {summary,fields,units,samples,columns} = await diagnosticSnapshot(pool,config.spaceId);
 const probes = [], dictionaries = [], activity = {};
 let count = 0, throttled = false, denied = false;
 const report = {generatedAt:now.toISOString(),summary,fields,units,probes,dictionaries,columns:[],
  activity:[],earliest:null};
 const budget = 70;
 async function get(name,path,query={},note="") {
  const entry = {name,endpoint:path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi,"{uid}").replace(/\/\d+(?=\/|$)/g,"/{id}"),
   status:null,result:"не проверено",note};
  probes.push(entry);
  if (!path || count >= budget || throttled || denied) {
   entry.result = throttled ? "остановлено после HTTP 429" : denied ? "остановлено после HTTP 401" : "нет образца или исчерпан лимит";
   return null;
  }
  if (count++) await pause(150);
  const url = new URL(config.kaitenBase + PREFIX + path);
  for (const [key,value] of Object.entries(query)) url.searchParams.set(key,String(value));
  let response;
  try {
   response = await fetcher(url,{method:"GET",redirect:"error",signal:AbortSignal.timeout(7000),
    headers:{Authorization:"Bearer "+config.kaitenToken,Accept:"application/json"}});
   entry.status = response.status;
   if (!response.ok) {
    throttled = response.status === 429;
    denied = response.status === 401;
    entry.result = ({401:"токен не принят",403:"нет прав",404:"не найдено или скрыто правами",
     405:"метод не поддержан",410:"ресурс снят",429:"лимит запросов",501:"метод не поддержан"})[response.status] || "ошибка API";
    await response.body?.cancel().catch(()=>{});
    return null;
   }
   const body = await readJson(response);
   const items = records(body);
   Object.assign(entry,shape(body,items),{count:items.length,hasNext:typeof body?.next_cursor==="string"});
   entry.result = items.length ? "получены данные" : "пустой ответ";
   const dates = items.map(item=>time(item?.created ?? item?.changed ?? item?.for_date)).filter(Boolean).sort();
   entry.earliest = dates[0] ?? null;
   entry.latest = dates.at(-1) ?? null;
   return body;
  } catch {
   entry.result = response ? "ответ превышает лимит или имеет неожиданный формат" : "ошибка сети или тайм-аут";
   return null;
  }
 }
 const readDictionary = async (label,path,query={limit:10,offset:0}) => {
  const result = await get(label,path,query,"Проверена ограниченная выборка; история справочника этим вызовом не проверяется.");
  dictionaries.push({name:label,count:result===null ? null : records(result).length});
  return result;
 };
 const card = samples[0], id = numericId(card?.id);
 const space = numericId(config.spaceId);
 const detail = id && await get("Детальная карточка","/cards/"+id,{broken_api:false});
 for (const field of ["owner_id","members","properties","checklists","parents_ids","children_ids","blocked","planned_start","estimate_workload","tag_ids","external_links","type_id"]) {
  const row = probes.find(probe=>probe.name==="Детальная карточка");
  if (detail && row) (row.fields ||= []).push(field+": "+(Object.hasOwn(detail,field) ? detail[field]===null ? "null" : "присутствует" : "ключ отсутствует"));
 }
 for (const [label,suffix,note] of [
  ["Участники и ответственные","members","Проверяются ключи роли и участника, без вывода их значений."],
  ["Теги карточки","tags","Текущие назначения."],
  ["Журнал времени карточки","time-logs","Существующие записи, первая страница."],
  ["Блокировки","blockers","Структура и признаки снятия, первая страница."],
  ["Базовые планы","baselines","Сохранённые планы, без истории каждой правки."],
  ["Комментарии","comments","Только ключи и диапазон дат выборки."],
  ["Дочерние карточки","children","Текущая связь, первая страница."],
  ["Внешние связи","external-links","Текущие ссылки без адресов и текста."]
 ]) await get(label,id?"/cards/"+id+"/"+suffix:"",{limit:5,offset:0},note);
 const details=[{id,body:detail}];
 const history = await get("Перемещения и авторы",id?"/cards/"+id+"/location-history":"",{},"Одна карточка; документированный метод без пагинации.");
 const historyProbe = probes.at(-1);
 if (history) historyProbe.fields = ["author_id присутствует: "+records(history).filter(r=>Object.hasOwn(r,"author_id")).length,
  "author_id заполнен: "+records(history).filter(r=>r.author_id!=null).length,
  "условия состояния в выборке: "+[...new Set(records(history).map(r=>r.condition).filter(c=>[1,2,3].includes(c)))].sort().join(", ")];
 const cardUid = uuid(detail?.uid ?? card?.uid);
 await get("История итераций",cardUid?"/cards/"+cardUid+"/iterations-history":"",{},"Режим без with_details, включая доступные удалённые записи участия.");
 for (const sample of samples.slice(1)) {
  const sampleId = numericId(sample.id);
  if (sampleId) {
   const body=await get("Детальная карточка · контроль", "/cards/"+sampleId,{broken_api:false});
   details.push({id:sampleId,body});
   await get("Перемещения и авторы · контроль","/cards/"+sampleId+"/location-history",{},"Дополнительная карточка; имена и ID авторов не публикуются.");
  }
 }
 for (const sample of details) {
  const checklist = numericId(sample.body?.checklists?.[0]?.id);
  if (checklist) {
   await get("Чек-лист","/cards/"+sample.id+"/checklists/"+checklist,{},"Первый доступный чек-лист.");
   break;
  }
 }
 if (!probes.some(row=>row.name==="Чек-лист")) await get("Чек-лист","",{},"В детальных ответах нет ID чек-листа.");
 const end = now.toISOString().slice(0,10);
 const start = new Date(now.getTime()-6*DAY).toISOString().slice(0,10);
 await get("Табель за семь дней","/time-logs",{from:start,to:end,space_ids:space,limit:5,offset:0},"Одна страница, выводятся только структура и количество.");
 await readDictionary("Пользователи пространства","/spaces/"+space+"/users");
 await readDictionary("Типы карточек","/card-types");
 await readDictionary("Справочник тегов","/tags");
 const properties = await readDictionary("Определения пользовательских полей","/company/custom-properties");
 const known = new Map();
 for (const prop of records(properties)) {
  if (numericId(prop.id)) known.set(String(prop.id),typeof prop.type==="number" ? String(prop.type) :
   typeof prop.type==="string" && /^[a-z][a-z_]{0,32}$/i.test(prop.type) ? prop.type : null);
 }
 for (const field of fields.filter(row=>row.scope==="Свойство").slice(0,5)) {
  const prop = await get("Определение свойства "+field.field,"/company/custom-properties/"+field.field);
  const type = prop?.type;
  if (typeof type==="number" || typeof type==="string" && /^[a-z][a-z_]{0,32}$/i.test(type)) known.set(field.field,String(type));
 }
 for (const row of fields.filter(row=>row.scope==="Свойство")) row.definition = known.get(row.field) ?? null;
 const propertyIds = [...new Set(details.flatMap(x=>Object.keys(x.body?.properties || {})).map(customKey).filter(Boolean))].slice(0,2);
 for (const prop of propertyIds) {
  await readDictionary("Варианты свойства "+prop,"/company/custom-properties/"+prop+"/select-values");
  await readDictionary("Каталог свойства "+prop,"/company/custom-properties/"+prop+"/catalog-values");
 }
 await readDictionary("Доски пространства","/spaces/"+space+"/boards");
 const board = numericId(card?.board_id), column = numericId(card?.column_id);
 await readDictionary("Дорожки",board?"/boards/"+board+"/lanes":"");
 await readDictionary("Подколонки",column?"/columns/"+column+"/subcolumns":"");

 const boardColumns = new Map();
 const boards = [...new Set([board,...columns.map(x=>numericId(x.board))].filter(Boolean))].slice(0,8);
 for (const currentBoard of boards) {
  await get("Доска · проверка существования","/boards/"+currentBoard,{},"Текущая доступность доски.");
  const body = await get("Колонки доски · текущие метаданные","/boards/"+currentBoard+"/columns",{limit:100,offset:0},
   "Отсутствие ID в этой выборке не устанавливает его историческое назначение.");
  boardColumns.set(currentBoard,{status:probes.at(-1).result,items:records(body)});
 }
 for (const row of columns) {
  const collection = boardColumns.get(row.board);
  const match = collection?.items.find(value=>numericId(value.id)===row.column);
  const title = match?.title;
  const confirmed=stages.filter(stage=>stage.spaceId===space && stage.boardId===row.board && stage.columnId===row.column);
  report.columns.push({...row,currentName:publicColumnNames.has(title)?title:null,
   nameStatus:match ? title && !publicColumnNames.has(title) ? "произвольное название скрыто" : "найдена" :
    collection?.items.length ? "ID отсутствует в полученных колонках" : collection?.status ?? "доска вне выборки",
   currentType:match && [1,2,3].includes(Number(match.type)) ? Number(match.type) : null,
   historicalName:null,processStage:confirmed.map(stage=>stage.stage).join("; ") || null,
   validity:confirmed.map(stage=>stage.from+" — "+(stage.to ?? "открытый интервал")+" (справочник FIT Requests)").join("; ") || null});
 }

 const activityPath = "/spaces/"+space+"/activity";
 for (const year of [2025,2026]) {
  for (const [month,day] of [["01","01"],["06","01"],["11","01"]]) {
   const from = year+"-"+month+"-"+day+"T00:00:00.000Z";
   const to = new Date(Date.parse(from)+14*DAY-1).toISOString();
   const label = from.slice(0,10)+" — "+to.slice(0,10);
   const body = await get("Активность WEB "+label,activityPath,{limit:20,created_after:from,created_before:to},
    "Одна страница ограниченного окна UTC. Отсутствие сцены в выборке не доказывает отсутствие истории.");
   if (body) activitySummary(body,label,activity,report.columns,from,to);
  }
 }
 // Bounded date search: ask if any event exists before a cutoff, then bisect
 // days. Validate returned timestamps so ignored date filters cannot pass.
 let newer = Date.parse(now.toISOString().slice(0,10)+"T00:00:00Z")+DAY;
 let older = Date.parse("2025-01-01T00:00:00Z");
 let earliest;
 async function hasBefore(cutoff) {
  const bound = new Date(cutoff).toISOString();
  const body = await get("Глубина активности до "+bound.slice(0,10),activityPath,{limit:1,created_before:bound},
   "Запрос существования записи до даты; проверяется возвращённая метка.");
  if (!body || !Array.isArray(body.items)) return null;
  if (!body.items.length) return false;
  const observed = time(body.items[0]?.created);
  if (!observed || Date.parse(observed)>cutoff) return null;
  if (!earliest || observed<earliest) earliest=observed;
  return true;
 }
 let beforeRange = await hasBefore(older);
 if (beforeRange === true) {
  newer = older;
  older = Date.parse("2020-01-01T00:00:00Z");
  beforeRange = await hasBefore(older);
 }
 if (beforeRange === false && await hasBefore(newer) === true) {
  while (newer-older>DAY) {
   const midpoint = older + Math.floor((newer-older)/DAY/2)*DAY;
   const exists = await hasBefore(midpoint);
   if (exists === null) break;
   if (exists) newer=midpoint;
   else older=midpoint;
  }
  report.earliest={observed:earliest,lower:new Date(older).toISOString(),upper:new Date(newer).toISOString(),
   note:newer-older<=DAY?"Граница доступной активности локализована с точностью до суток UTC.":"Граница ограничена по результатам неполного поиска."};
 } else {
  report.earliest={observed:earliest ?? probes.filter(row=>row.name.startsWith("Активность WEB") && row.earliest)
   .map(row=>row.earliest).sort()[0] ?? null,note:beforeRange===true?
    "API возвращает события до 2020 года. Точная нижняя граница за пределами проверенного диапазона.":
    "Нижнюю границу подтвердить не удалось."};
 }
 report.activity=Object.keys(historyFields).map(category=>({
  category,events:activity[category]?.events ?? 0,beforeAfter:activity[category]?.beforeAfter ?? 0,
  windows:[...activity[category]?.windows ?? []].join("; ")
 }));
 return report;
}

export function makeDiagnostics(options) {
 let report = null, error = false, task;
 let lastStart = 0;
 function start() {
  if (task || Date.now()-lastStart<60000) return false;
  lastStart = Date.now();
  error = false;
  task = runDiagnostics(options).then(result=>{report=result;},()=>{error=true;})
   .finally(()=>{task=null;});
  return true;
 }
 return {start,status:()=>({report,error,running:Boolean(task)})};
}
