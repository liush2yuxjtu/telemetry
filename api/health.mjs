import { createNeonQuery } from '../collector/neon.mjs';

export default async function handler(req, res) {
  if (String(req.method || '').toUpperCase() !== 'GET') {
    res.statusCode = 405;
    res.setHeader('allow', 'GET');
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }
  try {
    await createNeonQuery()('select 1 as ok', []);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ ok: true, database: true }));
  } catch {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ ok: false, database: false }));
  }
}
