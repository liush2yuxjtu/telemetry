import { createNeonQuery } from '../collector/neon.mjs';
import { buildAggregateSnapshot } from '../collector/report.mjs';

const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/;

export function parseFunnelOptions(req) {
  const url = new URL(req?.url || '/', 'https://telemetry.local');
  const packageName = url.searchParams.get('package');
  const version = url.searchParams.get('version');
  const includeTestRaw = url.searchParams.get('include_test');

  if (packageName !== null && (!PACKAGE_RE.test(packageName) || packageName.length > 214)) {
    throw new Error('invalid package filter');
  }
  if (version !== null && !VERSION_RE.test(version)) {
    throw new Error('invalid version filter');
  }
  if (includeTestRaw !== null && !['0', '1', 'false', 'true'].includes(includeTestRaw.toLowerCase())) {
    throw new Error('invalid include_test filter');
  }

  return {
    packageName,
    version,
    includeTest: includeTestRaw !== null && ['1', 'true'].includes(includeTestRaw.toLowerCase()),
  };
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
    options = parseFunnelOptions(req);
  } catch {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('access-control-allow-origin', '*');
    return res.end(JSON.stringify({ error: 'invalid_query' }));
  }

  try {
    const snapshot = await buildAggregateSnapshot(createNeonQuery(), options);
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
