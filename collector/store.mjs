/**
 * Storage for accepted funnel events.
 *
 * The handler only depends on this small interface, so the deployment target is
 * a configuration choice rather than a rewrite:
 *
 *   insert(event)  -> Promise<void>   idempotent on event_id
 *
 * `createSqlStore` adapts any SQL backend that can run parameterized statements
 * (Neon/Postgres over HTTP, node-postgres, SQLite with a small shim, or a
 * vendor SDK). `createMemoryStore` is for tests and local dry runs.
 */

import { COLUMNS, toRow } from './schema.mjs';

const INSERT_SQL = `insert into telemetry_events (${COLUMNS.join(', ')})
values (${COLUMNS.map((_, index) => `$${index + 1}`).join(', ')})
on conflict (event_id) do nothing`;

/**
 * @param {(text: string, params: unknown[]) => Promise<unknown>} query
 */
export function createSqlStore(query) {
  if (typeof query !== 'function') throw new Error('createSqlStore requires a query function');
  return {
    async insert(event) {
      await query(INSERT_SQL, toRow(event));
    },
  };
}

/** In-memory store: same contract, no durability. */
export function createMemoryStore() {
  const byId = new Map();
  return {
    async insert(event) {
      if (!byId.has(event.event_id)) byId.set(event.event_id, event);
    },
    all: () => [...byId.values()],
    size: () => byId.size,
  };
}
