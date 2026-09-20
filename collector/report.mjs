/**
 * Aggregate-only read model for the public funnel dashboard.
 *
 * This deliberately returns no event ids, anonymous install ids, timestamps,
 * IPs, headers, or free text. It exposes only package/version counts and rates.
 */

const SQL = `
select package,
       version,
       count(distinct anonymous_install_id) as distinct_installs,
       count(*) filter (where event = 'install') as installs,
       count(*) filter (where event = 'activated') as activated,
       count(*) filter (where event = 'first_success') as first_success,
       count(*) filter (where event = 'd7_retained') as d7_retained,
       count(distinct anonymous_install_id) filter (where event = 'weekly_active') as weekly_active,
       count(*) filter (where event = 'feedback' and feedback = 'positive') as feedback_positive,
       count(*) filter (where event = 'feedback' and feedback = 'neutral') as feedback_neutral,
       count(*) filter (where event = 'feedback' and feedback = 'negative') as feedback_negative
from telemetry_events
where ci = false
group by package, version
order by package, version
`;

const n = value => Number(value ?? 0);
const rate = (num, den) => den > 0 ? num / den : null;

/**
 * @param {(text: string, params: unknown[]) => Promise<unknown[]>} query
 */
export async function buildAggregateSnapshot(query) {
  const rows = await query(SQL, []);
  const packages = (Array.isArray(rows) ? rows : []).map(row => {
    const installs = n(row.installs);
    const activated = n(row.activated);
    const firstSuccess = n(row.first_success);
    const d7Retained = n(row.d7_retained);
    return {
      package: String(row.package),
      version: String(row.version),
      distinct_installs: n(row.distinct_installs),
      installs,
      activated,
      first_success: firstSuccess,
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
        first_success_to_d7_retained: rate(d7Retained, firstSuccess),
      },
    };
  });

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    privacy: 'aggregate_only_no_identifiers',
    packages,
    totals: {
      distinct_package_versions: packages.length,
      installs: packages.reduce((sum, row) => sum + row.installs, 0),
      activated: packages.reduce((sum, row) => sum + row.activated, 0),
      first_success: packages.reduce((sum, row) => sum + row.first_success, 0),
      d7_retained: packages.reduce((sum, row) => sum + row.d7_retained, 0),
      weekly_active: packages.reduce((sum, row) => sum + row.weekly_active, 0),
    },
  };
}
