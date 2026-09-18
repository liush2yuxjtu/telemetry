-- Funnel storage for schema-v1 telemetry events.
--
-- Deliberately absent: ip, user_agent, headers, hostname, path, request_id, and
-- any free-text column. The collector cannot store what the schema does not
-- have. Aggregation runs on these columns only.
--
-- Works on Postgres 12+ (Neon, RDS, AliCloud RDS, Supabase). SQLite needs only
-- the `text` and `integer` types plus dropping `timestamptz` defaults.

create table if not exists telemetry_events (
  event_id            text primary key,
  schema_version      integer     not null,
  event               text        not null,
  anonymous_install_id text       not null,
  package             text        not null,
  version             text        not null,
  client_timestamp    timestamptz not null,
  os                  text        not null,
  node_major          integer     not null,
  ci                  boolean     not null,
  feature             text,
  week                text,
  feedback            text,
  received_at         timestamptz not null default now()
);

create index if not exists telemetry_events_package_time on telemetry_events (package, client_timestamp);
create index if not exists telemetry_events_install on telemetry_events (anonymous_install_id);
create index if not exists telemetry_events_event on telemetry_events (event);

-- One row per install id and version, first occurrence wins, for stable funnel
-- ratios that do not inflate when a client upgrades mid-week.
create or replace view telemetry_install_first_seen as
select anonymous_install_id, package, version, min(client_timestamp) as first_seen
from telemetry_events
group by anonymous_install_id, package, version;

-- Funnel counts per package and version. Ratios are computed by scripts/funnel.mjs
-- so the denominators stay visible in the report instead of being hidden in SQL.
create or replace view telemetry_funnel_counts as
select package,
       version,
       count(*) filter (where event = 'install')        as installs,
       count(*) filter (where event = 'activated')      as activated,
       count(*) filter (where event = 'first_success')  as first_success,
       count(*) filter (where event = 'd7_retained')    as d7_retained,
       count(distinct anonymous_install_id) filter (where event = 'weekly_active') as weekly_active_installs
from telemetry_events
where ci = false
group by package, version;

-- Retention job: pseudonymous rows are deleted after the published window.
-- Run daily; the window is a product decision recorded in the collector README.
-- delete from telemetry_events where received_at < now() - interval '180 days';
