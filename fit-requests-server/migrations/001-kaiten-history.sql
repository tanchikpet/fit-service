CREATE TABLE IF NOT EXISTS kaiten_location_events (
  space_id bigint NOT NULL,
  card_id bigint NOT NULL,
  event_id bigint NOT NULL,
  changed_at timestamptz NOT NULL,
  board_id bigint,
  column_id bigint,
  subcolumn_id bigint,
  lane_id bigint,
  sprint_id bigint,
  condition integer,
  PRIMARY KEY (space_id, card_id, event_id)
);
CREATE INDEX IF NOT EXISTS kaiten_location_events_by_board
  ON kaiten_location_events (space_id, board_id, card_id, changed_at);

CREATE TABLE IF NOT EXISTS kaiten_history_loads (
  space_id bigint NOT NULL,
  card_id bigint NOT NULL,
  last_attempt_at timestamptz NOT NULL,
  last_success_at timestamptz,
  result text NOT NULL CHECK (result IN ('loaded', 'empty', 'forbidden', 'not_found', 'error')),
  http_status integer,
  PRIMARY KEY (space_id, card_id)
);
