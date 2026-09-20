const GROKBOT_NOTIFY_URL =
  'https://grokbot.tail6a877d.ts.net/agent-tasks/v1/notify';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export default async function handler(req, res) {
  const method = String(req.method || '').toUpperCase();

  if (method === 'GET') {
    return json(res, 200, {
      ok: true,
      service: 'grokbot-event-hub',
      mode: 'event-driven',
      polling: false,
      target: 'grokbot-agent-tasks',
    });
  }

  if (method !== 'POST') {
    res.setHeader('allow', 'GET, POST');
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  const payload = parseBody(req);
  if (!payload) {
    return json(res, 400, { ok: false, error: 'invalid_json' });
  }

  if (
    payload.type !== 'INSERT' ||
    payload.schema !== 'ops_event_bus' ||
    payload.table !== 'grokbot_task_events'
  ) {
    return json(res, 400, { ok: false, error: 'unsupported_event' });
  }

  const eventId = nonEmptyString(payload.record?.event_id);
  const recordId = nonEmptyString(payload.record?.record_id);
  const eventType = nonEmptyString(payload.record?.event_type);

  if (
    !eventId ||
    eventId.length > 160 ||
    !recordId ||
    !/^rec[A-Za-z0-9]{14}$/.test(recordId) ||
    eventType !== 'grokbot.task.ready'
  ) {
    return json(res, 422, { ok: false, error: 'invalid_event_contract' });
  }

  let upstream;
  try {
    upstream = await fetch(GROKBOT_NOTIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recordId, eventId }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return json(res, 502, {
      ok: false,
      error: 'grokbot_unreachable',
      eventId,
    });
  }

  if (!upstream.ok) {
    return json(res, 502, {
      ok: false,
      error: 'grokbot_rejected',
      eventId,
      upstreamStatus: upstream.status,
    });
  }

  return json(res, 202, {
    ok: true,
    accepted: true,
    eventId,
    recordId,
  });
}
