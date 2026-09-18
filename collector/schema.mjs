/**
 * Schema-v1 event validation for the funnel collector.
 *
 * The collector is the trust boundary: a client can send anything, so every
 * field is allow-listed and every value is re-checked here. Unknown keys are
 * rejected outright, which is what makes it impossible for a future client
 * (buggy or malicious) to smuggle hostnames, file paths, prompts, user agents,
 * or IP addresses into storage.
 *
 * Nothing in this module reads request metadata. It only sees a parsed payload.
 */

export const SCHEMA_VERSION = 1;
export const EVENTS = ['install', 'activated', 'first_success', 'd7_retained', 'weekly_active', 'feedback'];
export const FEEDBACK_VALUES = ['positive', 'neutral', 'negative'];

const ALLOWED_KEYS = new Set([
  'schema_version', 'event', 'event_id', 'anonymous_install_id',
  'package', 'version', 'timestamp', 'os', 'node_major', 'ci',
  'feature', 'week', 'feedback',
]);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/;
const FEATURE = /^[a-z][a-z0-9_-]{0,47}$/;
const WEEK = /^\d{4}-\d{2}-\d{2}$/;
const OS = /^[a-z0-9]{1,32}$/;

/**
 * Strictly validate one event.
 * @returns {{ok: true, event: object} | {ok: false, error: string}}
 */
export function validateEvent(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('payload must be an object');
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) return fail(`unknown field: ${key}`);
  }
  if (input.schema_version !== SCHEMA_VERSION) return fail('unsupported schema_version');
  if (!EVENTS.includes(input.event)) return fail('unknown event');
  if (typeof input.event_id !== 'string' || !UUID_V4.test(input.event_id)) return fail('event_id must be a v4 uuid');
  if (typeof input.anonymous_install_id !== 'string' || !UUID_V4.test(input.anonymous_install_id)) {
    return fail('anonymous_install_id must be a v4 uuid');
  }
  if (typeof input.package !== 'string' || input.package.length > 214 || !PACKAGE_NAME.test(input.package)) {
    return fail('invalid package name');
  }
  if (typeof input.version !== 'string' || !VERSION.test(input.version)) return fail('invalid version');
  if (typeof input.timestamp !== 'string' || !isIsoTimestamp(input.timestamp)) return fail('timestamp must be ISO-8601');
  if (typeof input.os !== 'string' || !OS.test(input.os)) return fail('invalid os');
  if (!Number.isInteger(input.node_major) || input.node_major < 14 || input.node_major > 99) return fail('invalid node_major');
  if (typeof input.ci !== 'boolean') return fail('ci must be boolean');

  if (input.feature !== undefined && (typeof input.feature !== 'string' || !FEATURE.test(input.feature))) {
    return fail('invalid feature');
  }
  if (input.week !== undefined) {
    if (typeof input.week !== 'string' || !WEEK.test(input.week)) return fail('invalid week');
    if (input.event !== 'weekly_active') return fail('week is only valid on weekly_active');
  }
  if (input.feedback !== undefined) {
    if (typeof input.feedback !== 'string' || !FEEDBACK_VALUES.includes(input.feedback)) return fail('invalid feedback');
    if (input.event !== 'feedback') return fail('feedback is only valid on feedback');
  }
  if (input.event === 'feedback' && input.feedback === undefined) return fail('feedback event requires a value');

  return {
    ok: true,
    event: {
      schema_version: SCHEMA_VERSION,
      event: input.event,
      event_id: input.event_id,
      anonymous_install_id: input.anonymous_install_id,
      package: input.package,
      version: input.version,
      timestamp: input.timestamp,
      os: input.os,
      node_major: input.node_major,
      ci: input.ci,
      feature: input.feature ?? null,
      week: input.week ?? null,
      feedback: input.feedback ?? null,
    },
  };
}

function fail(error) {
  return { ok: false, error };
}

function isIsoTimestamp(value) {
  if (value.length !== 24 || !value.endsWith('Z')) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/**
 * Columns persisted for an accepted event. There is deliberately no ip, user
 * agent, header, or hostname column: the funnel never stores connection
 * metadata, so aggregation cannot leak it later.
 */
export const COLUMNS = [
  'event_id', 'schema_version', 'event', 'anonymous_install_id', 'package', 'version',
  'client_timestamp', 'os', 'node_major', 'ci', 'feature', 'week', 'feedback',
];

/** Row shape for the SQL store. `received_at` is set by the database. */
export function toRow(event) {
  return [
    event.event_id, event.schema_version, event.event, event.anonymous_install_id,
    event.package, event.version, event.timestamp, event.os, event.node_major,
    event.ci, event.feature, event.week, event.feedback,
  ];
}
