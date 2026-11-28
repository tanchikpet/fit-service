export async function readKaitenCoverage(db,space){
 const {rows:[row]}=await db.query(String.raw`WITH raw_cards AS (
  SELECT c.*, COALESCE(NULLIF(d.payload->'properties'->'id_428033','null'),NULLIF(d.payload->'properties'->'428033','null'),
   NULLIF(c.data->'properties'->'id_428033','null'),NULLIF(c.data->'properties'->'428033','null')) AS raw_rr
  FROM kaiten_cards c LEFT JOIN kaiten_enrichment_sources d ON d.space_id=c.space_id AND d.subject=c.id::text
   AND d.source='detail' AND d.source_version=COALESCE(extract(epoch FROM c.updated_at)::text,'')
  WHERE c.space_id=$1
 ), cards AS (
  SELECT *,CASE WHEN raw_rr IN ('[]','{}','""') THEN NULL ELSE raw_rr END AS rr FROM raw_cards
 ), state AS (
  SELECT e.* FROM kaiten_enrichment_sources e JOIN cards c ON e.subject=c.id::text WHERE e.space_id=$1
 ), failures AS (
  SELECT subject,count(DISTINCT source) AS sources
  FROM state WHERE source IN ('detail','members','tags','comments','links','children','blockers') AND http_status=403
  GROUP BY subject
 ), locations AS (
  SELECT e.author_id,(to_jsonb(e)->>'author_field_present')::boolean author_field_present,
   to_jsonb(e)->>'author_checked_at' author_checked_at,h.http_status,h.result FROM kaiten_location_events e
  LEFT JOIN kaiten_history_loads h USING(space_id,card_id) WHERE e.space_id=$1
 ), links AS (
  SELECT c.id,field,value FROM cards c
  LEFT JOIN state child ON child.subject=c.id::text AND child.source='children'
   AND child.source_version=COALESCE(extract(epoch FROM c.updated_at)::text,'')
  LEFT JOIN state detail ON detail.subject=c.id::text AND detail.source='detail'
   AND detail.source_version=COALESCE(extract(epoch FROM c.updated_at)::text,'')
  CROSS JOIN LATERAL (VALUES
   ('parents',COALESCE(detail.payload->'parents_ids',c.data->'parents_ids')),
   ('children',COALESCE(NULLIF(child.payload,'[]'),c.data->'children_ids'))) j(field,entries)
  CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(entries)='array' THEN entries ELSE '[]' END) AS value
 ), distributions AS (
  SELECT 'board' AS axis,board_id::text AS key,count(*)::int AS total FROM cards GROUP BY board_id
  UNION ALL SELECT 'type',data->>'type_id',count(*)::int FROM cards GROUP BY data->>'type_id'
  UNION ALL SELECT 'priority',COALESCE(rr::text,'∅'),count(*)::int FROM cards GROUP BY rr
  UNION ALL SELECT 'members',NULL,count(*) FILTER (WHERE member_ids<>'[]')::int FROM cards
 ), participant_load AS (
   SELECT amount AS cards_per_participant,count(*)::int AS participants FROM (
    SELECT member,count(DISTINCT c.id)::int AS amount FROM cards c
    CROSS JOIN LATERAL jsonb_array_elements_text(c.member_ids) AS member GROUP BY member
   ) per_member GROUP BY amount
 ), cross_priority AS (
  SELECT extract(year FROM (data->>'created')::timestamptz AT TIME ZONE 'Asia/Novosibirsk') AS year,
   board_id,data->>'type_id' AS type,rr,count(*)::int AS total
   FROM cards WHERE (data->>'created') ~ '^\d{4}-\d{2}-\d{2}T' AND pg_input_is_valid(data->>'created','timestamp with time zone')
   GROUP BY 1,2,3,4
 )
 SELECT (SELECT count(*)::int FROM cards) AS cards,
  (SELECT jsonb_build_object('types',count(*) FILTER(WHERE data->>'type_id' IS NOT NULL),
    'due',count(*) FILTER(WHERE COALESCE(data->>'due_date',data->>'due') IS NOT NULL),
    'estimate',count(*) FILTER(WHERE estimate_raw IS NOT NULL),'owners',count(owner_id),
    'members',count(*) FILTER(WHERE member_ids<>'[]'),'priority',count(rr))
   FROM cards) AS fields,
  (SELECT jsonb_agg(t ORDER BY source,result,http_status) FROM (
   SELECT source,result,http_status,count(*)::int AS total,count(last_success_at)::int AS saved
   FROM state GROUP BY 1,2,3) t) AS sources,
  (SELECT count(*)::int FROM failures WHERE sources=7) AS common_forbidden,
  (SELECT count(*)::int FROM failures f JOIN kaiten_history_loads h ON h.space_id=$1 AND h.card_id::text=f.subject
   WHERE sources=7 AND h.http_status=403) AS common_forbidden_with_history,
  (SELECT jsonb_build_object('cards', count(last_success_at),'legacyAuthorCards',count((to_jsonb(h)->>'authors_checked_at')),
    'permissionErrors',count(*) FILTER(WHERE h.http_status IN (403,404)),
    'otherErrors',count(*) FILTER(WHERE h.result='error'))
   FROM kaiten_history_loads h WHERE h.space_id=$1) AS history,
  (SELECT jsonb_build_object('total',count(*),'withAuthor',count(author_id),
   'noAuthor',count(*) FILTER(WHERE author_id IS NULL AND author_field_present),
   'fieldMissing',count(*) FILTER(WHERE author_id IS NULL AND author_field_present=false),
   'unprocessed',count(*) FILTER(WHERE author_id IS NULL AND author_checked_at IS NULL AND http_status IS DISTINCT FROM 403
     AND http_status IS DISTINCT FROM 404 AND (result IS NULL OR result IN ('loaded','empty'))),
   'failed',count(*) FILTER(WHERE author_id IS NULL AND author_checked_at IS NULL AND result IN ('forbidden','not_found','error')))
   FROM locations) AS authors,
  (SELECT count(*)::int FROM (SELECT id,field,value FROM links GROUP BY 1,2,3 HAVING count(*)>1) d) AS repeated_relation_ids,
  (SELECT count(*)::int FROM links l WHERE NOT EXISTS(SELECT FROM cards c WHERE c.id::text=l.value)) AS external_relation_ids,
  (SELECT count(*)::int FROM links WHERE id::text=value) AS self_relations,
  (SELECT jsonb_agg(distributions ORDER BY axis,key) FROM distributions) AS distributions,
  (SELECT jsonb_agg(participant_load ORDER BY cards_per_participant) FROM participant_load) AS participant_load,
  (SELECT jsonb_agg(cross_priority ORDER BY year,board_id,type) FROM cross_priority) AS priority_by_group`,[space]);
 return row;
}
