const BASE = 'https://grokbot.tail6a877d.ts.net';
const RESOURCE = BASE + '/wechat-mcp/mcp';
const TARGETS = [
  BASE + '/wechat-mcp/healthz',
  RESOURCE,
  BASE + '/wechat-mcp/.well-known/oauth-protected-resource',
  BASE + '/.well-known/oauth-protected-resource/wechat-mcp/mcp',
  BASE + '/.well-known/oauth-authorization-server',
  BASE + '/healthz',
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
      body: body.slice(0, 3000),
    };
  } catch (error) {
    return { url, ok: false, error: error?.name || 'fetch_error', message: String(error?.message || error) };
  }
}

function parseMcpText(text) {
  const data = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      const raw = line.slice(5).trim();
      if (!raw) continue;
      try { data.push(JSON.parse(raw)); } catch {}
    }
  }
  if (data.length) return data[data.length - 1];
  try { return JSON.parse(text); } catch { return { raw: String(text || '').slice(0, 5000) }; }
}

async function registerClient() {
  const r = await fetch(BASE + '/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      client_name: 'telemetry-wechat-inspect',
      grant_types: ['client_credentials'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'mcp'
    }),
    signal: AbortSignal.timeout(8000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('register ' + r.status + ': ' + text.slice(0, 1000));
  return JSON.parse(text);
}

async function getToken(client) {
  const form = new URLSearchParams();
  form.set('grant_type', 'client_credentials');
  form.set('client_id', client.client_id);
  if (client.client_secret) form.set('client_secret', client.client_secret);
  form.set('scope', 'mcp');
  form.set('resource', RESOURCE);
  const r = await fetch(BASE + '/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
    body: form,
    signal: AbortSignal.timeout(8000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('token ' + r.status + ': ' + text.slice(0, 1000));
  return JSON.parse(text);
}

async function mcpRequest(token, payload, sessionId) {
  const headers = {
    authorization: 'Bearer ' + token,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const r = await fetch(RESOURCE, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  return {
    ok: r.ok,
    status: r.status,
    sessionId: r.headers.get('mcp-session-id') || sessionId || null,
    contentType: r.headers.get('content-type'),
    parsed: parseMcpText(text),
  };
}

async function inspectTools() {
  const client = await registerClient();
  const token = await getToken(client);
  const init = await mcpRequest(token.access_token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'telemetry-wechat-inspect', version: '1.0.0' }
    }
  });
  if (!init.ok) return { stage: 'initialize', init };

  await mcpRequest(token.access_token, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {}
  }, init.sessionId);

  const list = await mcpRequest(token.access_token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  }, init.sessionId);

  return {
    stage: 'tools/list',
    init: { ok: init.ok, status: init.status, sessionId: Boolean(init.sessionId), result: init.parsed?.result || null },
    tools: list.parsed?.result?.tools || [],
    status: list.status,
  };
}

export default async function handler(req, res) {
  if (String(req.method || '').toUpperCase() !== 'GET') {
    res.setHeader('allow', 'GET');
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }
  const results = await Promise.all(TARGETS.map(probe));
  let inspect = null;
  if (String(req.query?.inspect || '') === '1') {
    try { inspect = await inspectTools(); }
    catch (error) { inspect = { error: String(error?.message || error) }; }
  }
  return json(res, 200, { ok: true, checkedAt: new Date().toISOString(), results, inspect });
}
