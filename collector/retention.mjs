/**
 * Retention enforcement.
 *
 * The published retention window is a promise, so it needs a job rather than a
 * comment in schema.sql. This runs daily against pseudonymous rows only: it
 * deletes by `received_at`, which is the collector's own clock and cannot be
 * influenced by a client-supplied timestamp.
 *
 * `?dry=1` reports how many rows would be removed without removing them, so the
 * window can be verified against real data before anything is deleted.
 */

export const RETENTION_DAYS = 180;

/** Cutoff timestamp for a retention window, computed from the injected clock. */
export function retentionCutoff(days = RETENTION_DAYS, now = new Date()) {
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error('retention days must be an integer between 1 and 3650');
  }
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export const COUNT_SQL = `select count(*)::int as expired
from telemetry_events
where received_at < now() - ($1::int * interval '1 day')`;

// `returning` is what makes the job able to report the truth: Neon's HTTP endpoint
// answers a bare DELETE with an empty row list, so counting the rows it returns is
// the only way to tell "deleted 12" from "deleted nothing, and the report lied".
export const DELETE_SQL = `delete from telemetry_events
where received_at < now() - ($1::int * interval '1 day')
returning event_id`;

/** Count rows past the window. Never deletes. */
export async function countExpired(query, days = RETENTION_DAYS) {
  const rows = await query(COUNT_SQL, [days]);
  const value = rows?.[0]?.expired ?? rows?.[0]?.count ?? 0;
  return Number(value);
}

/** Delete rows past the window and report how many the database actually removed. */
export async function deleteExpired(query, days = RETENTION_DAYS) {
  const rows = await query(DELETE_SQL, [days]);
  if (!Array.isArray(rows)) return 0;
  if (rows.length > 0 && typeof rows[0]?.count === 'number') return Number(rows[0].count);
  return rows.length;
}
