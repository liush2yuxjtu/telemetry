import { createNeonQuery } from '../collector/neon.mjs';
import { buildSourceSnapshot } from '../collector/source-report.mjs';
import { parseAudience } from '../collector/audience.mjs';

export function parseSourceOptions(req) {
  const url = new URL(req?.url || '/', 'https://telemetry.local');
  return { audience: parseAudience(url.searchParams.get('audience')) };
}

export default async function handler(req, res) {
  if (String(req.method || '').toUpperCase() !== 'GET') {
    res.statusCode = 405;
    res.setHeader('allow', 'GET');
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('access-control-allow-origin', '*');
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }
  let options;
  try {
    options = parseSourceOptions(req);
  } catch {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('access-control-allow-origin', '*');
    return res.end(JSON.stringify({ error: 'invalid_query' }));
  }
  try {
    const snapshot = await buildSourceSnapshot(createNeonQuery(), options);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('access-control-allow-origin', '*');
    res.end(JSON.stringify(snapshot));
  } catch {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('access-control-allow-origin', '*');
    res.end(JSON.stringify({ error: 'analytics_unavailable' }));
  }
}
