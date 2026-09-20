/**
 * Daily retention job, called by a Vercel Cron.
 *
 * Deletes pseudonymous rows older than the published window. Same auth model as
 * the digest: when CRON_SECRET is set the request must carry
 * `Authorization: Bearer <secret>`, which Vercel Cron sends automatically.
 * `?dry=1` counts what would be deleted and deletes nothing.
 */

import { createNeonQuery } from '../collector/neon.mjs';
import { RETENTION_DAYS, countExpired, deleteExpired } from '../collector/retention.mjs';

export default async function handler(req, res) {
  const url = new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`);
  const dry = url.searchParams.get('dry') === '1';
  const secret = process.env.CRON_SECRET;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');

  if (secret) {
    if (String(req.headers.authorization ?? '') !== `Bearer ${secret}`) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
  }

  let query;
  try {
    query = createNeonQuery();
  } catch {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: 'storage_not_configured' }));
  }

  try {
    if (dry) {
      const expired = await countExpired(query, RETENTION_DAYS);
      res.statusCode = 200;
      return res.end(JSON.stringify({ dryRun: true, retentionDays: RETENTION_DAYS, expired }));
    }
    const deleted = await deleteExpired(query, RETENTION_DAYS);
    res.statusCode = 200;
    return res.end(JSON.stringify({ dryRun: false, retentionDays: RETENTION_DAYS, deleted }));
  } catch {
    // Status only: the connection string must never reach a log line.
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: 'retention_failed' }));
  }
}
