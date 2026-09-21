const TARGETS = [
  'https://grokbot.tail6a877d.ts.net/wechat-mcp/healthz',
  'https://grokbot.tail6a877d.ts.net/wechat-mcp/mcp',
  'https://grokbot.tail6a877d.ts.net/healthz',
];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function probe(url) {
  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    const body = await r.text();
    return {
      url,
      ok: r.ok,
      status: r.status,
      location: r.headers.get('location'),
      contentType: r.headers.get('content-type'),
      body: body.slice(0, 500),
    };
  } catch (error) {
    return { url, ok: false, error: error?.name || 'fetch_error', message: String(error?.message || error) };
  }
}

export default async function handler(req, res) {
  if (String(req.method || '').toUpperCase() !== 'GET') {
    res.setHeader('allow', 'GET');
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }
  const results = await Promise.all(TARGETS.map(probe));
  return json(res, 200, {
    ok: true,
    checkedAt: new Date().toISOString(),
    results,
  });
}
