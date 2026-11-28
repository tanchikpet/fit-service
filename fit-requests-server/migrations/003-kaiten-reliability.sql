ALTER TABLE kaiten_location_events ADD COLUMN IF NOT EXISTS author_checked_at timestamptz;
ALTER TABLE kaiten_location_events ADD COLUMN IF NOT EXISTS author_field_present boolean;
CREATE TABLE IF NOT EXISTS kaiten_reliability_runs (
 space_id bigint NOT NULL,
 kind text NOT NULL CHECK (kind IN ('daily','urgent','manual','checklists','authors')),
 slot date,
 phase integer NOT NULL DEFAULT 0,
 batches integer NOT NULL DEFAULT 0,
 started_at timestamptz NOT NULL,
 finished_at timestamptz,
 last_success_at timestamptz,
 outcome jsonb NOT NULL DEFAULT '{}',
 database_before bigint NOT NULL,
 database_after bigint,
 requests integer NOT NULL DEFAULT 0,
 PRIMARY KEY (space_id,kind)
);
CREATE TABLE IF NOT EXISTS kaiten_observed_snapshots (
 space_id bigint NOT NULL,
 card_id bigint NOT NULL,
 value jsonb NOT NULL,
 PRIMARY KEY (space_id, card_id)
);
CREATE TABLE IF NOT EXISTS kaiten_observed_changes (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 space_id bigint NOT NULL,
 card_id bigint NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 event_at timestamptz,
 old_values jsonb NOT NULL,
 new_values jsonb NOT NULL
);
