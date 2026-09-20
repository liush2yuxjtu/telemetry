/**
 * Daily digest endpoint, called by a Vercel Cron.
 *
 * It reads aggregate counts only (no event rows leave the database), builds the
 * funnel digest, and optionally pushes it to a chat webhook. Auth: when
 * CRON_SECRET is set, the request must carry `Authorization: Bearer <secret>`,
 * which Vercel Cron sends automatically. `?dry=1` returns the digest without
 * pushing, so the pipeline can be verified without messaging anyone.
 *
 * Nothing here is hidden by design: this is a documented endpoint whose whole job
 * is to tell the owner how the packages are being used.
 */

import { createNeonQuery } from '../collector/neon.mjs';
import { buildDigest, formatDigestText, webhookBody } from '../collector/digest.mjs';

const WINDOW_DAYS = 30;

const AGGREGATE_SQL = `select package, event,
       count(distinct anonymous_install_id)::int as installs
from telemetry_events
where ci = false
  and received_at >= now() - ($1::int * interval '1 day')
  and received_at <  now() - ($2::int * interval '1 day')
group by package, event`;

async function loadWindow(query, offsetDays) {
  const rows = await query(AGGREGATE_SQL, [WINDOW_DAYS + offsetDays, offsetDays]);
  return rows ?? [];
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const url = new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`);
  const dry = url.searchParams.get('dry') === '1';

  if (secret) {
    const header = String(req.headers.authorization ?? '');
    if (header !== `Bearer ${secret}`) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }

  let digest;
  try {
    const query = createNeonQuery();
    const current = (await loadWindow(query, 0)).map((row) => ({ ...row, window: 'current' }));
    const previous = (await loadWindow(query, WINDOW_DAYS)).map((row) => ({ ...row, window: 'previous' }));
    digest = buildDigest([...current, ...previous], { windowDays: WINDOW_DAYS });
  } catch (error) {
    // Status only: a digest failure must not leak a connection string into a log.
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'digest_unavailable' }));
    return;
  }

  const text = formatDigestText(digest);
  const webhook = process.env.DIGEST_WEBHOOK_URL;
  let pushed = false;
  let pushError;

  if (webhook && !dry) {
    try {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(webhookBody(webhook, text, digest)),
      });
      pushed = response.ok;
      if (!response.ok) pushError = `webhook http ${response.status}`;
    } catch {
      pushError = 'webhook unreachable';
    }
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ pushed, pushError, text, digest }));
}
