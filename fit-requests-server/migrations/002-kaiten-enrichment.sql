ALTER TABLE kaiten_location_events ADD COLUMN IF NOT EXISTS author_id bigint;
ALTER TABLE kaiten_history_loads ADD COLUMN IF NOT EXISTS authors_checked_at timestamptz;

CREATE TABLE IF NOT EXISTS kaiten_dictionary_versions (
 version_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 space_id bigint NOT NULL,
 source text NOT NULL,
 entity_id text NOT NULL,
 value jsonb NOT NULL,
 first_observed_at timestamptz NOT NULL,
 last_observed_at timestamptz NOT NULL,
 replaced_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS kaiten_dictionary_current
 ON kaiten_dictionary_versions(space_id,source,entity_id) WHERE replaced_at IS NULL;

CREATE TABLE IF NOT EXISTS kaiten_enrichment_sources (
 space_id bigint NOT NULL,
 subject text NOT NULL,
 source text NOT NULL,
 payload jsonb,
 last_success_at timestamptz,
 source_version text,
 last_attempt_at timestamptz NOT NULL,
 result text NOT NULL CHECK (result IN ('ok','empty','forbidden','not_found','error')),
 http_status integer,
 PRIMARY KEY (space_id,subject,source)
);

CREATE TABLE IF NOT EXISTS kaiten_enrichment_workflow (
 space_id bigint PRIMARY KEY,
 state jsonb NOT NULL DEFAULT '{}'
);
