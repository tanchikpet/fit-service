import {listKaitenLocations} from "./kaiten.js";

export const HISTORY_LOCK = 332384502;

export async function loadCardHistory({pool, config, cardId, fetcher, wait, onSaved}) {
 const {spaceId, kaitenBase: base, kaitenToken: token} = config;
 const attemptedAt = new Date();
 let events;
 let status;
 let result;
 try {
  events = await listKaitenLocations({base, token, cardId, fetcher, wait});
  status = 200;
  result = events.length ? "loaded" : "empty";
 } catch (error) {
  status = error.status ?? null;
  result = status === 403 ? "forbidden" : status === 404 ? "not_found" : "error";
 }
 let inserted = 0;
 const client = await pool.connect();
 try {
  await client.query("BEGIN");
  if (events?.length) {
   const saved = await client.query(`INSERT INTO kaiten_location_events
     (space_id,card_id,event_id,changed_at,board_id,column_id,subcolumn_id,lane_id,sprint_id,condition,author_id)
     SELECT $1,$2,e.* FROM jsonb_to_recordset($3) AS e
       (event_id bigint,changed_at timestamptz,board_id bigint,column_id bigint,
        subcolumn_id bigint,lane_id bigint,sprint_id bigint,condition integer,author_id bigint)
     ON CONFLICT (space_id,card_id,event_id) DO NOTHING`, [spaceId,cardId,JSON.stringify(events)]);
   inserted = saved.rowCount;
   await client.query(`UPDATE kaiten_location_events old SET author_id=e.author_id
    FROM jsonb_to_recordset($3) AS e(event_id bigint,author_id bigint)
    WHERE old.space_id=$1 AND old.card_id=$2 AND old.event_id=e.event_id
      AND old.author_id IS NULL AND e.author_id IS NOT NULL`,[spaceId,cardId,JSON.stringify(events)]);
  }
  await client.query(`INSERT INTO kaiten_history_loads
     (space_id,card_id,last_attempt_at,last_success_at,result,http_status,authors_checked_at)
     VALUES ($1,$2,$6,CASE WHEN $3::boolean THEN now() END,$4,$5,CASE WHEN $3::boolean THEN now() END)
     ON CONFLICT (space_id,card_id) DO UPDATE SET
       last_attempt_at=EXCLUDED.last_attempt_at,
       last_success_at=COALESCE(EXCLUDED.last_success_at,kaiten_history_loads.last_success_at),
       authors_checked_at=COALESCE(EXCLUDED.authors_checked_at,kaiten_history_loads.authors_checked_at),
       result=EXCLUDED.result,http_status=EXCLUDED.http_status`, [spaceId,cardId,Boolean(events),result,status,attemptedAt]);
  await client.query("COMMIT");
  onSaved?.({inserted,received:events?.length ?? 0,status});
  return result;
 } catch (error) {
  await client.query("ROLLBACK");
  throw error;
 } finally {
  client.release();
 }
}

export async function refreshHistory({pool, config, mode = "pending", ids = [], fetcher = fetch,
 wait = ms => new Promise(resolve => setTimeout(resolve,ms)), shouldStop, onProgress}) {
 if (!["pending","all","authors"].includes(mode)) throw new Error("Invalid history refresh mode");
 const lock = await pool.connect();
 let acquired = false;
 try {
  const {rows: [state]} = await lock.query("SELECT pg_try_advisory_lock($1) AS acquired", [HISTORY_LOCK]);
  acquired = state.acquired;
  if (!acquired) return {skipped: "history refresh already running"};
  const {rows} = await lock.query(`SELECT c.id FROM kaiten_cards c
    LEFT JOIN kaiten_history_loads h ON h.space_id=c.space_id AND h.card_id=c.id
    WHERE c.space_id=$1 AND (
     (cardinality($3::bigint[]) > 0 AND c.id=ANY($3)) OR
     (cardinality($3::bigint[]) = 0 AND ($2='all' OR ($2='authors' AND h.authors_checked_at IS NULL)
      OR ($2='pending' AND (h.last_success_at IS NULL OR h.result NOT IN ('loaded','empty') OR c.updated_at > h.last_attempt_at)))))
    ORDER BY c.id`, [config.spaceId,mode,ids]);
  const totals = {selected: rows.length, loaded: 0, empty: 0, forbidden: 0, not_found: 0, error: 0};
  onProgress?.({...totals,processed:0,inserted:0,received:0});
  let next = 0;
  let processed = 0, inserted = 0, received = 0, failed = false;
  let nextRequestAt = 0;
  async function pacedFetch(url, options) {
   const now = performance.now();
   const start = Math.max(now,nextRequestAt);
   nextRequestAt = start + 150;
   if (start > now) await wait(start-now);
   return fetcher(url,options);
  }
  async function worker() {
   try {
    while (!failed && !shouldStop?.() && next < rows.length) {
     const {id: cardId} = rows[next++];
     let status;
     const result = await loadCardHistory({pool,config,cardId,fetcher:pacedFetch,wait,onSaved: row => {
      inserted += row.inserted;
      received += row.received;
      status = row.status;
     }});
     totals[result]++;
     processed++;
     onProgress?.({...totals,processed,inserted,received,status,result});
    }
   } catch (error) {
    failed = true;
    throw error;
   }
  }
  // Wait for both workers before releasing the cross-process lock, even on a database failure.
  const workers = await Promise.allSettled([worker(),worker()]);
  if (workers.some(worker => worker.status === "rejected")) throw new Error("History refresh database failure");
  return totals;
 } finally {
  let discard = false;
  if (acquired) {
   try { await lock.query("SELECT pg_advisory_unlock($1)", [HISTORY_LOCK]); }
   catch { discard = true; }
  }
  lock.release(discard);
 }
}
