import pg from "pg";
export function makeDb(url){const pool=new pg.Pool({connectionString:url,max:5,connectionTimeoutMillis:10000});return pool}
export async function setupDb(pool){
 await pool.query(`
 CREATE TABLE IF NOT EXISTS kaiten_cards (
  id bigint PRIMARY KEY, space_id bigint NOT NULL, title text NOT NULL,
  updated_at timestamptz, board_id bigint, column_id bigint, lane_id bigint,
  state text, archived boolean NOT NULL DEFAULT false,
  owner_id bigint, member_ids jsonb NOT NULL DEFAULT '[]',
  estimate_raw jsonb, estimate_unit text, estimate_text text, spent_raw jsonb,
  children_count integer, children_done integer, data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS kaiten_cards_space_updated ON kaiten_cards(space_id,updated_at DESC);
 CREATE TABLE IF NOT EXISTS kaiten_sync_state (
  space_id bigint PRIMARY KEY, last_success_at timestamptz, last_started_at timestamptz,
  last_error text, cards_seen integer NOT NULL DEFAULT 0, pages_seen integer NOT NULL DEFAULT 0
 );
 `);
}
export async function upsertCards(client,cards){
 for(const c of cards){
  await client.query(`INSERT INTO kaiten_cards(id,space_id,title,updated_at,board_id,column_id,lane_id,state,archived,owner_id,member_ids,estimate_raw,estimate_unit,estimate_text,spent_raw,children_count,children_done,data,synced_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15::jsonb,$16,$17,$18::jsonb,now())
  ON CONFLICT(id) DO UPDATE SET space_id=EXCLUDED.space_id,title=EXCLUDED.title,updated_at=EXCLUDED.updated_at,board_id=EXCLUDED.board_id,column_id=EXCLUDED.column_id,lane_id=EXCLUDED.lane_id,state=EXCLUDED.state,archived=EXCLUDED.archived,owner_id=EXCLUDED.owner_id,member_ids=EXCLUDED.member_ids,estimate_raw=EXCLUDED.estimate_raw,estimate_unit=EXCLUDED.estimate_unit,estimate_text=EXCLUDED.estimate_text,spent_raw=EXCLUDED.spent_raw,children_count=EXCLUDED.children_count,children_done=EXCLUDED.children_done,data=EXCLUDED.data,synced_at=now()
  WHERE kaiten_cards.updated_at IS NULL OR EXCLUDED.updated_at IS NULL OR EXCLUDED.updated_at >= kaiten_cards.updated_at`,
  [c.id,c.spaceId,c.title,c.updated,c.boardId,c.columnId,c.laneId,c.status,c.archived,c.ownerId,JSON.stringify(c.assigneeIds),c.estimateRaw===null?null:JSON.stringify(c.estimateRaw),c.estimateUnit,c.estimateText,c.spentRaw===null?null:JSON.stringify(c.spentRaw),c.childrenCount,c.childrenDone,JSON.stringify(c.raw)]);
 }
}
