import {readFileSync} from "node:fs";
import {kaitenTimestamp} from "./kaiten.js";

export const TIME_ZONE = "Asia/Novosibirsk";
const registry = JSON.parse(readFileSync(new URL("./kaiten-process.json",import.meta.url),"utf8"));
const monthFormat = new Intl.DateTimeFormat("sv-SE",{timeZone:TIME_ZONE,year:"numeric",month:"2-digit"});
export const localMonth = date => monthFormat.format(date);
const isMonth = value => /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value);
const isId = value => /^[1-9]\d{0,18}$/.test(String(value ?? ""));
const hasOwn = (object,key) => Object.hasOwn(object,key);

export const methodology = [
 "Выборка ограничена карточками, сохранёнными сервером. Отсутствие в ответе списка или HTTP 403/404 не подтверждает удаление.",
 "Создания считаются по дате created. Для созданий и состава доска берётся из текущего снимка карточки.",
 "Поступление — самое раннее доступное событие с ID выбранной доски за всю сохранённую историю карточки. Повторный вход и архивирование на той же доске не увеличивают счётчик. Самое раннее событие может отражать уже существовавшую карточку.",
 "Наличие родителя для всех показателей определяется по текущему снимку. Исторические изменения связей неизвестны. Карточки с неизвестной иерархией исключаются при выборе «С родителем» или «Без родителя».",
 "Охват истории указан для всей сохранённой выборки с выбранным фильтром родителя. Текущая доска не ограничивает эту выборку, поскольку карточка могла перейти на другую доску.",
 "Положительные значения отражают известные записи и могут быть неполными. После ошибки учитываются ранее полученные события. Ноль относится только к доступным данным. «Нет данных» обозначает недоступный показатель.",
 "Период ограничивает события создания и поступления. Состав отражает последние сохранённые состояния, которые могли быть обновлены в разное время.",
 "Месяцы и время отображаются по Новосибирску. Для сопоставления годов выбирайте одинаковые завершённые месяцы.",
 "Массовые переносы входят в поступления. Выполнение, производительность и соблюдение сроков требуют подтверждённых бизнес-правил и исторических соответствий."
];

export function reportFilters(params, now = new Date()) {
 const current = localMonth(now);
 const from = params.get("from") || current.slice(0,4) + "-01";
 const to = params.get("to") || current;
 const board = params.get("board") || "";
 const parent = params.get("parent") || "all";
 if (!isMonth(from) || !isMonth(to) || from > to || from > current ||
     Number(to.slice(0,4)) - Number(from.slice(0,4)) > 10 ||
     (board && (!isId(board) || BigInt(board) > 9223372036854775807n)) || !["all","yes","no"].includes(parent)) {
  throw new RangeError("Укажите корректный период до 11 календарных лет и фильтры отчёта.");
 }
 return {from,to,board,parent};
}

// Intervals in the repository dictionary are UTC, inclusive at start and exclusive at end.
export function stageAt(spaceId, boardId, columnId, instant, dictionary = registry) {
 if (boardId == null || columnId == null || !instant) return null;
 const matches = dictionary.stages.filter(row =>
  String(row.spaceId) === String(spaceId) && String(row.boardId) === String(boardId) &&
  String(row.columnId) === String(columnId) &&
  instant >= new Date(row.from) && (!row.to || instant < new Date(row.to)));
 return matches.length === 1 ? matches[0].stage : null;
}

export function parentStatus(data) {
 const count = data.parents_count;
 if (Number.isSafeInteger(count) && count >= 0) return count > 0 ? "yes" : "no";
 if (hasOwn(data,"parents_ids") && (Array.isArray(data.parents_ids) || data.parents_ids === null)) {
  return data.parents_ids?.length ? "yes" : "no";
 }
 return "unknown";
}

function increment(map,key,fields) {
 const row = map.get(key);
 if (row) row.count++;
 else map.set(key,{...fields,count:1});
}

function monthsIn(from,to) {
 const date = new Date(from + "-01T00:00:00Z");
 const months = [];
 while (date.toISOString().slice(0,7) <= to) {
  months.push(date.toISOString().slice(0,7));
  date.setUTCMonth(date.getUTCMonth() + 1);
 }
 return months;
}

export function buildReport({spaceId, cards, events, syncAt, syncFailed = false, filters, historicalBoards = [], now = new Date()}) {
 const {from,to,board,parent} = filters;
 const names = registry.boards[spaceId] || {};
 const boards = new Set([
  ...Object.keys(names),board,...historicalBoards,
  ...cards.map(card => card.board_id),...events.map(event => event.board_id)
 ].filter(Boolean));
 const candidates = cards.filter(card => parent === "all" || parent === card.parent);
 const currentCards = candidates.filter(card => !board || board === card.board_id);
 const coverage = {total:candidates.length,loaded:0,empty:0,forbidden:0,not_found:0,error:0,
  pending:0,successful:0,stale:0,oldestSuccessAt:null,latestSuccessAt:null,
  unknownParents:cards.filter(card => card.parent === "unknown").length,
  unknownCreated:currentCards.filter(card => !card.created).length};
 const history = new Set();
 for (const card of candidates) {
  coverage[card.result || "pending"]++;
  if (!card.last_success_at) continue;
  coverage.successful++;
  history.add(card.id);
  if (card.updated_at > card.last_attempt_at || !["loaded","empty"].includes(card.result)) coverage.stale++;
  if (!coverage.oldestSuccessAt || card.last_success_at < coverage.oldestSuccessAt) coverage.oldestSuccessAt = card.last_success_at;
  if (!coverage.latestSuccessAt || card.last_success_at > coverage.latestSuccessAt) coverage.latestSuccessAt = card.last_success_at;
 }
 const created = new Map();
 const statuses = new Map();
 for (const card of currentCards) {
  if (card.created && card.created <= now) {
   const month = localMonth(card.created);
   created.set(month,(created.get(month) || 0)+1);
  }
  const condition = card.condition;
  const stage = stageAt(spaceId,card.board_id,card.column_id,card.synced_at);
  const status = card.archived || condition === "2" ? "Архив" :
   condition === "3" ? "Удалена по состоянию Kaiten" : stage ||
    (card.column_id ? "Неподтверждённая колонка" : "Колонка неизвестна");
  const fields = {board:card.board_id,column:card.column_id,status,state:card.state,condition};
  increment(statuses,JSON.stringify(fields),fields);
 }
 const first = new Map();
 const unknown = new Map();
 for (const event of events) {
  if (!history.has(event.card_id) || (board && event.board_id !== board) || event.changed_at > now) continue;
  if (board) {
   const previous = first.get(event.card_id);
   if (!previous || event.changed_at < previous) first.set(event.card_id,event.changed_at);
  }
  const month = localMonth(event.changed_at);
  if (month < from || month > to || stageAt(spaceId,event.board_id,event.column_id,event.changed_at)) continue;
  const fields = {board:event.board_id,column:event.column_id};
  increment(unknown,JSON.stringify(fields),fields);
 }
 const arrivals = new Map();
 for (const date of first.values()) {
  const month = localMonth(date);
  arrivals.set(month,(arrivals.get(month) || 0)+1);
 }
 const current = localMonth(now);
 const createdThrough = syncAt && localMonth(syncAt);
 const arrivalsThrough = coverage.latestSuccessAt && localMonth(coverage.latestSuccessAt);
 const months = monthsIn(from,to < current ? to : current).map(month => ({
  month,
  created:created.get(month) ?? (createdThrough && month <= createdThrough &&
   !coverage.unknownCreated && (!board || cards.every(card => card.board_id)) &&
   (parent === "all" || !coverage.unknownParents) ? 0 : null),
  arrivals:arrivals.get(month) ?? (board && arrivalsThrough && month <= arrivalsThrough ? 0 : null),
  partial:month === current || month === createdThrough || Boolean(board && month === arrivalsThrough)
 }));
 return {
  filters, timeZone:TIME_ZONE, currentAsOf:syncAt, syncFailed, dictionaryVersion:registry.version, coverage, months,
  boards:[...boards].map(id => ({id,label:names[id] || "Неподтверждённая доска " + id})).sort((a,b) => a.label.localeCompare(b.label,"ru")),
  statuses:[...statuses.values()].sort((a,b) => b.count - a.count),
  unconfirmed:[...unknown.values()].sort((a,b) => b.count - a.count),
  methodology
 };
}

export async function readReport(pool,spaceId,filters,now) {
 const client = await pool.connect();
 try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const {rows: [sync]} = await client.query(
   "SELECT last_success_at,last_error FROM kaiten_sync_state WHERE space_id=$1",[spaceId]);
  const {rows} = await client.query(`SELECT c.id,c.board_id,c.column_id,c.archived,c.state,c.synced_at,c.updated_at,
    c.data->>'created' AS created,c.data->>'condition' AS condition,
    c.data->'parents_count' AS parents_count, c.data->'parents_ids' AS parents_ids,
    c.data ? 'parents_ids' AS has_parents_ids,h.last_attempt_at,h.last_success_at,h.result
    FROM kaiten_cards c LEFT JOIN kaiten_history_loads h ON h.space_id=c.space_id AND h.card_id=c.id
    WHERE c.space_id=$1 ORDER BY c.id`,[spaceId]);
  const {rows: events} = await client.query(`SELECT card_id,board_id,column_id,changed_at
    FROM kaiten_location_events WHERE space_id=$1
    AND ($2::bigint IS NULL OR board_id=$2)`,[spaceId,filters.board || null]);
  // List historical boards even when a single board was selected.
  const historicalBoards = filters.board ? (await client.query(
   "SELECT DISTINCT board_id FROM kaiten_location_events WHERE space_id=$1 AND board_id IS NOT NULL",[spaceId])).rows : [];
  await client.query("COMMIT");
  const cards = rows.map(card => ({...card,created:kaitenTimestamp(card.created),parent:parentStatus(
   card.has_parents_ids ? card : {parents_count:card.parents_count}
  )}));
  return buildReport({spaceId,cards,events,syncAt:sync?.last_success_at ?? null,
   syncFailed:Boolean(sync?.last_error),filters,historicalBoards:historicalBoards.map(row => row.board_id),now});
 } catch (error) {
  await client.query("ROLLBACK");
  throw error;
 } finally {
  client.release();
 }
}
