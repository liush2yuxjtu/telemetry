/**
 * Aggregate-only install-source analytics.
 * Groups installation cohorts by OS, Node major, package and first-install version.
 * No event ids or anonymous installation ids leave this module.
 */

const SQL = `
with filtered as (
  select *
  from telemetry_events
  where ci = false
    and package <> 'telemetry-smoke'
),
cohorts as (
  select distinct on (anonymous_install_id, package)
         anonymous_install_id,
         package,
         version as cohort_version,
         os,
         node_major,
         client_timestamp as install_at
  from filtered
  where event = 'install'
  order by anonymous_install_id, package, client_timestamp, received_at, event_id
),
activation as (
  select c.*,
         min(e.client_timestamp) filter (
           where e.event = 'activated'
             and e.client_timestamp >= c.install_at
         ) as activated_at,
         bool_or(
           e.event = 'weekly_active'
           and e.week = to_char(date_trunc('week', $1::timestamptz at time zone 'UTC'), 'YYYY-MM-DD')
         ) as weekly_active
  from cohorts c
  left join filtered e
    on e.anonymous_install_id = c.anonymous_install_id
   and e.package = c.package
  group by c.anonymous_install_id, c.package, c.cohort_version, c.os, c.node_major, c.install_at
),
success as (
  select a.*,
         min(e.client_timestamp) filter (
           where e.event = 'first_success'
             and a.activated_at is not null
             and e.client_timestamp >= a.activated_at
         ) as first_success_at
  from activation a
  left join filtered e
    on e.anonymous_install_id = a.anonymous_install_id
   and e.package = a.package
  group by a.anonymous_install_id, a.package, a.cohort_version, a.os, a.node_major,
           a.install_at, a.activated_at, a.weekly_active
),
retention as (
  select s.*,
         min(e.client_timestamp) filter (
           where e.event = 'd7_retained'
             and s.first_success_at is not null
             and e.client_timestamp >= s.first_success_at + interval '7 days'
             and e.client_timestamp <  s.first_success_at + interval '8 days'
         ) as d7_at
  from success s
  left join filtered e
    on e.anonymous_install_id = s.anonymous_install_id
   and e.package = s.package
  group by s.anonymous_install_id, s.package, s.cohort_version, s.os, s.node_major,
           s.install_at, s.activated_at, s.first_success_at, s.weekly_active
)
select os,
       node_major,
       package,
       cohort_version as version,
       count(*)::bigint as installs,
       count(*) filter (where activated_at is not null)::bigint as activated,
       count(*) filter (where first_success_at is not null)::bigint as first_success,
       count(*) filter (
         where first_success_at is not null
           and first_success_at <= $1::timestamptz - interval '8 days'
       )::bigint as d7_eligible,
       count(*) filter (
         where d7_at is not null
           and first_success_at <= $1::timestamptz - interval '8 days'
       )::bigint as d7_retained,
       count(*) filter (where weekly_active)::bigint as weekly_active
from retention
group by os, node_major, package, cohort_version
order by installs desc, package, cohort_version, os, node_major
`;

const n = value => Number(value ?? 0);
const rate = (num, den) => den > 0 ? num / den : null;

function aggregate(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const current = map.get(key) ?? { installs: 0, activated: 0, first_success: 0, d7_eligible: 0, d7_retained: 0, weekly_active: 0 };
    for (const field of Object.keys(current)) current[field] += row[field];
    map.set(key, current);
  }
  return map;
}

/**
 * @param {(text: string, params: unknown[]) => Promise<unknown[]>} query
 * @param {{now?: Date|string|number}} options
 */
export async function buildSourceSnapshot(query, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new Error('invalid analytics clock');

  const raw = await query(SQL, [now.toISOString()]);
  const rows = (Array.isArray(raw) ? raw : []).map(row => {
    const installs = n(row.installs);
    const activated = n(row.activated);
    const firstSuccess = n(row.first_success);
    const d7Eligible = n(row.d7_eligible);
    const d7Retained = n(row.d7_retained);
    return {
      os: String(row.os),
      node_major: n(row.node_major),
      package: String(row.package),
      version: String(row.version),
      installs,
      activated,
      first_success: firstSuccess,
      d7_eligible: d7Eligible,
      d7_retained: d7Retained,
      weekly_active: n(row.weekly_active),
      conversion: {
        install_to_activated: rate(activated, installs),
        activated_to_first_success: rate(firstSuccess, activated),
        first_success_to_d7_retained: rate(d7Retained, d7Eligible),
      },
    };
  });

  const totalInstalls = rows.reduce((sum, row) => sum + row.installs, 0);
  const osMap = aggregate(rows, row => row.os);
  const nodeMap = aggregate(rows, row => String(row.node_major));

  const os = [...osMap.entries()].map(([name, metrics]) => ({
    os: name,
    ...metrics,
    share_of_installs: totalInstalls > 0 ? metrics.installs / totalInstalls : null,
  })).sort((a, b) => b.installs - a.installs || a.os.localeCompare(b.os));

  const node_major = [...nodeMap.entries()].map(([major, metrics]) => ({
    node_major: Number(major),
    ...metrics,
    share_of_installs: totalInstalls > 0 ? metrics.installs / totalInstalls : null,
  })).sort((a, b) => b.installs - a.installs || a.node_major - b.node_major);

  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    privacy: 'aggregate_only_no_identifiers',
    cohorting: 'first_install_version_and_install_device',
    totals: {
      installs: totalInstalls,
      activated: rows.reduce((sum, row) => sum + row.activated, 0),
      first_success: rows.reduce((sum, row) => sum + row.first_success, 0),
      d7_eligible: rows.reduce((sum, row) => sum + row.d7_eligible, 0),
      d7_retained: rows.reduce((sum, row) => sum + row.d7_retained, 0),
      weekly_active: rows.reduce((sum, row) => sum + row.weekly_active, 0),
    },
    os,
    node_major,
    rows,
  };
}
