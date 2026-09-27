/**
 * Audience filter shared by the aggregate read models.
 *
 * `all` keeps every non-CI install cohort (the historical behaviour).
 * `likely_human` additionally drops two kinds of installs that are real
 * `ci = false` traffic but not people using the package:
 *
 * - internal: install ids the owner registered in INTERNAL_INSTALL_IDS (their own
 *   machines and agents). The id lives in the SDK state file on that machine.
 * - matrix_burst: members of any window of at most BURST_WINDOW_MINUTES
 *   (earliest to latest first `install`) holding at least BURST_MIN_INSTALLS
 *   installs of the same package version across BURST_MIN_ENVIRONMENTS
 *   distinct OS + Node major combinations. One person does not install the same version on three
 *   different runtimes within minutes; a test matrix does.
 *
 * The filter runs server-side on the collector's own clock (`received_at`) and
 * only aggregate counts leave the database.
 */

export const AUDIENCES = ['all', 'likely_human'];
export const BURST_WINDOW_MINUTES = 15;
export const BURST_MIN_INSTALLS = 3;
export const BURST_MIN_ENVIRONMENTS = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** @param {string|null|undefined} raw */
export function parseAudience(raw) {
  if (raw === null || raw === undefined || raw === '') return 'all';
  if (!AUDIENCES.includes(raw)) throw new Error('invalid audience filter');
  return raw;
}

/** Comma/whitespace separated UUIDs; anything malformed is ignored. */
export function internalInstallIds(env = process.env) {
  return [...new Set(String(env.INTERNAL_INSTALL_IDS ?? '')
    .split(/[\s,]+/)
    .map(id => id.trim().toLowerCase())
    .filter(id => UUID.test(id)))];
}

/** Postgres array literal; ids are validated UUIDs, so no quoting is needed. */
export function pgTextArray(ids) {
  return `{${ids.join(',')}}`;
}

/**
 * CTEs ending in `excluded_installs(anonymous_install_id, package, reason)`.
 * @param {number} audienceParam placeholder index holding the audience text
 * @param {number} idsParam placeholder index holding the internal id text[]
 */
export function excludedInstallsSql(audienceParam, idsParam) {
  const audience = `$${audienceParam}::text`;
  return `
first_installs as (
  select distinct on (anonymous_install_id, package)
         anonymous_install_id, package, version, os, node_major, received_at
  from telemetry_events
  where ci = false
    and event = 'install'
    and ${audience} = 'likely_human'
  order by anonymous_install_id, package, received_at, event_id
),
burst_windows as (
  select a.package, a.version, a.received_at as start_at
  from first_installs a
  join first_installs g
    on g.package = a.package
   and g.version = a.version
   and g.received_at between a.received_at and a.received_at + interval '${BURST_WINDOW_MINUTES} minutes'
  group by a.anonymous_install_id, a.package, a.version, a.received_at
  having count(distinct g.anonymous_install_id) >= ${BURST_MIN_INSTALLS}
     and count(distinct (g.os, g.node_major)) >= ${BURST_MIN_ENVIRONMENTS}
),
burst_installs as (
  select distinct g.anonymous_install_id, g.package
  from burst_windows w
  join first_installs g
    on g.package = w.package
   and g.version = w.version
   and g.received_at between w.start_at and w.start_at + interval '${BURST_WINDOW_MINUTES} minutes'
),
excluded_installs as (
  select anonymous_install_id, package, 'matrix_burst'::text as reason
  from burst_installs
  union
  select distinct anonymous_install_id, package, 'internal'::text
  from telemetry_events
  where ${audience} = 'likely_human'
    and anonymous_install_id = any($${idsParam}::text[])
)`;
}

/** Predicate for a `telemetry_events` alias: true when the row survives the filter. */
export function keepInstallSql(alias) {
  return `not exists (
      select 1 from excluded_installs x
      where x.anonymous_install_id = ${alias}.anonymous_install_id
        and x.package = ${alias}.package
    )`;
}
