/**
 * Aggregate-only read model for the public funnel dashboard.
 *
 * Funnel stages are cohort-based, not raw event counts: each installation is
 * assigned to the version of its first install event, and later activation /
 * success / retention events stay in that cohort even after package upgrades.
 * This guarantees monotonic stage counts and prevents >100% conversions.
 */

const SQL = `
with filtered as (
  select *
  from telemetry_events
  where ci = false
    and ($1::text is null or package = $1::text)
    and ($3::boolean = true or package <> 'telemetry-smoke')
),
cohorts as (
  select distinct on (anonymous_install_id, package)
         anonymous_install_id,
         package,
         version as cohort_version,
         client_timestamp as install_at
  from filtered
  where event = 'install'
  order by anonymous_install_id, package, client_timestamp, received_at, event_id
),
activation as (
  select c.anonymous_install_id,
         c.package,
         c.cohort_version,
         c.install_at,
         min(e.client_timestamp) filter (
           where e.event = 'activated'
             and e.client_timestamp >= c.install_at
         ) as activated_at,
         count(*) filter (
           where e.event = 'feedback'
             and e.feedback = 'positive'
             and e.client_timestamp >= c.install_at
         ) as feedback_positive,
         count(*) filter (
           where e.event = 'feedback'
             and e.feedback = 'neutral'
             and e.client_timestamp >= c.install_at
         ) as feedback_neutral,
         count(*) filter (
           where e.event = 'feedback'
             and e.feedback = 'negative'
             and e.client_timestamp >= c.install_at
         ) as feedback_negative,
         bool_or(
           e.event = 'weekly_active'
           and e.week = to_char(date_trunc('week', $4::timestamptz at time zone 'UTC'), 'YYYY-MM-DD')
         ) as weekly_active
  from cohorts c
  left join filtered e
    on e.anonymous_install_id = c.anonymous_install_id
   and e.package = c.package
  where ($2::text is null or c.cohort_version = $2::text)
  group by c.anonymous_install_id, c.package, c.cohort_version, c.install_at
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
  group by a.anonymous_install_id, a.package, a.cohort_version, a.install_at,
           a.activated_at, a.feedback_positive, a.feedback_neutral,
           a.feedback_negative, a.weekly_active
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
  group by s.anonymous_install_id, s.package, s.cohort_version, s.install_at,
           s.activated_at, s.first_success_at, s.feedback_positive,
           s.feedback_neutral, s.feedback_negative, s.weekly_active
)
select package,
       cohort_version as version,
       count(*)::bigint as distinct_installs,
       count(*)::bigint as installs,
       count(*) filter (where activated_at is not null)::bigint as activated,
       count(*) filter (where first_success_at is not null)::bigint as first_success,
       count(*) filter (
         where first_success_at is not null
           and first_success_at <= $4::timestamptz - interval '8 days'
       )::bigint as d7_eligible,
       count(*) filter (
         where d7_at is not null
           and first_success_at <= $4::timestamptz - interval '8 days'
       )::bigint as d7_retained,
       count(*) filter (where weekly_active)::bigint as weekly_active,
       coalesce(sum(feedback_positive), 0)::bigint as feedback_positive,
       coalesce(sum(feedback_neutral), 0)::bigint as feedback_neutral,
       coalesce(sum(feedback_negative), 0)::bigint as feedback_negative
from retention
group by package, cohort_version
order by package, cohort_version
`;

const DIAGNOSTICS_SQL = `
with scoped as (
  select *
  from telemetry_events
  where ci = false
    and ($1::text is null or package = $1::text)
)
select
  count(distinct (e.package, e.anonymous_install_id)) filter (
    where ($2::boolean = true or e.package <> 'telemetry-smoke')
      and e.event = 'activated'
      and not exists (
        select 1 from scoped i
        where i.package = e.package
          and i.anonymous_install_id = e.anonymous_install_id
          and i.event = 'install'
          and i.client_timestamp <= e.client_timestamp
      )
  )::bigint as orphan_activated,
  count(distinct (e.package, e.anonymous_install_id)) filter (
    where ($2::boolean = true or e.package <> 'telemetry-smoke')
      and e.event = 'first_success'
      and not exists (
        select 1 from scoped a
        where a.package = e.package
          and a.anonymous_install_id = e.anonymous_install_id
          and a.event = 'activated'
          and a.client_timestamp <= e.client_timestamp
      )
  )::bigint as orphan_first_success,
  count(*) filter (
    where $2::boolean = false and e.package = 'telemetry-smoke'
  )::bigint as test_events_excluded
from scoped e
`;

const n = value => Number(value ?? 0);
const rate = (num, den) => den > 0 ? num / den : null;

/**
 * @param {(text: string, params: unknown[]) => Promise<unknown[]>} query
 * @param {{packageName?: string|null, version?: string|null, includeTest?: boolean, now?: Date|string|number}} options
 */
export async function buildAggregateSnapshot(query, options = {}) {
  const packageName = options.packageName ?? null;
  const version = options.version ?? null;
  const includeTest = options.includeTest === true;
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new Error('invalid analytics clock');

  const rows = await query(SQL, [packageName, version, includeTest, now.toISOString()]);
  const diagnosticRows = await query(DIAGNOSTICS_SQL, [packageName, includeTest]);
  const diagnostic = Array.isArray(diagnosticRows) && diagnosticRows[0] ? diagnosticRows[0] : {};

  const packages = (Array.isArray(rows) ? rows : []).map(row => {
    const installs = n(row.installs);
    const activated = n(row.activated);
    const firstSuccess = n(row.first_success);
    const d7Eligible = n(row.d7_eligible);
    const d7Retained = n(row.d7_retained);
    return {
      package: String(row.package),
      version: String(row.version),
      distinct_installs: n(row.distinct_installs),
      installs,
      activated,
      first_success: firstSuccess,
      d7_eligible: d7Eligible,
      d7_retained: d7Retained,
      weekly_active: n(row.weekly_active),
      feedback: {
        positive: n(row.feedback_positive),
        neutral: n(row.feedback_neutral),
        negative: n(row.feedback_negative),
      },
      conversion: {
        install_to_activated: rate(activated, installs),
        activated_to_first_success: rate(firstSuccess, activated),
        first_success_to_d7_retained: rate(d7Retained, d7Eligible),
      },
    };
  });

  return {
    schema_version: 2,
    generated_at: now.toISOString(),
    privacy: 'aggregate_only_no_identifiers',
    cohorting: 'first_install_version',
    filters: {
      package: packageName,
      version,
      include_test: includeTest,
    },
    packages,
    diagnostics: {
      orphan_activated: n(diagnostic.orphan_activated),
      orphan_first_success: n(diagnostic.orphan_first_success),
      test_events_excluded: n(diagnostic.test_events_excluded),
    },
    totals: {
      distinct_package_versions: packages.length,
      installs: packages.reduce((sum, row) => sum + row.installs, 0),
      activated: packages.reduce((sum, row) => sum + row.activated, 0),
      first_success: packages.reduce((sum, row) => sum + row.first_success, 0),
      d7_eligible: packages.reduce((sum, row) => sum + row.d7_eligible, 0),
      d7_retained: packages.reduce((sum, row) => sum + row.d7_retained, 0),
      weekly_active: packages.reduce((sum, row) => sum + row.weekly_active, 0),
    },
  };
}
