/**
 * Neon SQL-over-HTTP adapter.
 *
 * The function runtime has no database driver and this package has no runtime
 * dependencies, so the collector talks to Postgres through Neon's HTTP endpoint
 * instead of `pg`. The request shape matches what Neon's official serverless
 * driver sends; the connection string travels in a header, never in a URL, query
 * string, or log line.
 *
 * Swap-in path if the HTTP endpoint ever changes: install
 * `@neondatabase/serverless` in a deploy-only manifest and pass its `sql` as the
 * query function to `createSqlStore`. Nothing else in the collector changes.
 */

/**
 * @param {{connectionString?: string, fetchImpl?: typeof fetch}} options
 * @returns {(text: string, params: unknown[]) => Promise<unknown[]>}
 */
export function createNeonQuery(options = {}) {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof connectionString !== 'string' || !connectionString.trim()) {
    throw new Error('DATABASE_URL is not configured');
  }
  const endpoint = sqlEndpoint(connectionString);

  return async function query(text, params) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'neon-connection-string': connectionString,
      },
      body: JSON.stringify({ query: text, params }),
    });
    if (!response.ok) {
      // Status only: the body can echo the statement, and the statement is never
      // a secret, but keeping it out of errors makes an accidental log harmless.
      throw new Error(`neon http ${response.status}`);
    }
    const payload = await response.json().catch(() => undefined);
    return Array.isArray(payload?.rows) ? payload.rows : [];
  };
}

/** Derive the HTTPS SQL endpoint from a Postgres connection string. */
export function sqlEndpoint(connectionString) {
  const url = new URL(connectionString);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must be a postgres:// connection string');
  }
  return `https://${url.host}/sql`;
}
