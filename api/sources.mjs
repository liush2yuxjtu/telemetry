import { createNeonQuery } from '../collector/neon.mjs';
import { buildSourceSnapshot } from '../collector/source-report.mjs';

export default async function handler(req, res) {
  if (String(req.method || '').toUpperCase() !== 'GET') {
    res.statusCode = 405;
    res.setHeader('allow', 'GET');
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }
  try {
    const snapshot = await buildSourceSnapshot(createNeonQuery());
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(snapshot));
  } catch {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ error: 'analytics_unavailable' }));
  }
}
