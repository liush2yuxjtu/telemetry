-- Export for scripts/funnel.mjs. Run against the collector database and write
-- the result to a JSON file; the script only ever reads that file.
--
--   psql "$DATABASE_URL" -At -f collector/export.sql > events.json
--
-- The exported rows are exactly the stored columns: no IP, no user agent, no
-- headers. `ci` is exported so the report can exclude automation explicitly.

select coalesce(json_agg(row_to_json(t)), '[]'::json)
from (
  select event, event_id, anonymous_install_id, package, version,
         client_timestamp as timestamp, os, node_major, ci, feature, week, feedback
  from telemetry_events
  order by client_timestamp
) t;
