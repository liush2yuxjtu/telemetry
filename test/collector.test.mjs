import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelemetry } from '../dist/index.js';
import { validateEvent, toRow, COLUMNS } from '../collector/schema.mjs';
import { createHandler, DEFAULT_MAX_BYTES, readBody } from '../collector/handler.mjs';
import { createMemoryStore, createSqlStore } from '../collector/store.mjs';
import { createNeonQuery, sqlEndpoint } from '../collector/neon.mjs';
import { nodeAdapter } from '../collector/adapters/node.mjs';
import { webAdapter } from '../collector/adapters/web.mjs';
import { buildReport, parseEvents, renderMarkdown } from '../scripts/funnel.mjs';
import { buildAggregateSnapshot } from '../collector/report.mjs';
import { buildSourceSnapshot } from '../collector/source-report.mjs';

let seq = 0;
const uuid = (n) => {
  const hex = String(n).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
};
const event = (overrides = {}) => ({
  schema_version: 1,
  event: 'install',
  event_id: uuid(seq++),
  anonymous_install_id: uuid(1),
  package: '@nyn5255/pi-debug-mode',
  version: '0.1.8',
  timestamp: '2026-09-18T00:00:00.000Z',
  os: 'darwin',
  node_major: 24,
  ci: false,
  ...overrides,
});

test('accepts a canonical event and keeps only schema fields', () => {
  const result = validateEvent(event({ event: 'weekly_active', week: '2026-09-14', feature: 'debug' }));
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.event).sort(), ['anonymous_install_id', 'ci', 'event', 'event_id', 'feature', 'feedback', 'node_major', 'os', 'package', 'schema_version', 'timestamp', 'version', 'week']);
  assert.equal(result.event.week, '2026-09-14');
  assert.equal(result.event.feedback, null);
});

test('rejects connection metadata a client might try to smuggle', () => {
  for (const extra of [{ ip: '1.2.3.4' }, { user_agent: 'x' }, { hostname: 'mac' }, { path: '/home/u' }, { headers: {} }]) {
    const result = validateEvent(event(extra));
    assert.equal(result.ok, false, JSON.stringify(extra));
    assert.match(result.error, /unknown field/);
  }
});

test('rejects malformed identifiers and enum violations', () => {
  const cases = [
    [{ schema_version: 2 }, /schema_version/],
    [{ event: 'purchase' }, /unknown event/],
    [{ event_id: 'not-a-uuid' }, /event_id/],
    [{ anonymous_install_id: '00000000-0000-1000-8000-000000000001' }, /anonymous_install_id/],
    [{ package: 'Bad Name' }, /package/],
    [{ version: '1.0' }, /version/],
    [{ timestamp: '2026-09-18' }, /timestamp/],
    [{ timestamp: '2026-09-18T00:00:00.000+08:00' }, /timestamp/],
    [{ os: 'Darwin 24' }, /os/],
    [{ node_major: 12 }, /node_major/],
    [{ node_major: '24' }, /node_major/],
    [{ ci: 'false' }, /ci/],
    [{ feature: 'Bad' }, /feature/],
    [{ week: '2026-09-14' }, /weekly_active/],
    [{ feedback: 'positive' }, /feedback/],
    [{ event: 'feedback' }, /requires a value/],
    [{ event: 'feedback', feedback: 'loved it' }, /invalid feedback/],
  ];
  for (const [override, pattern] of cases) {
    const result = validateEvent(event(override));
    assert.equal(result.ok, false, JSON.stringify(override));
    assert.match(result.error, pattern);
  }
  for (const bad of [null, [], 'install', 42]) assert.equal(validateEvent(bad).ok, false);
});

test('toRow matches the stored column order and carries no metadata', () => {
  const row = toRow(validateEvent(event()).event);
  assert.equal(row.length, COLUMNS.length);
  assert.equal(String(row.join(',')).includes('1.2.3.4'), false);
});

test('handler enforces method, content type, size, and shape', async () => {
  const store = createMemoryStore();
  const handle = createHandler({ store });
  const send = (body, init = {}) => handle({ method: init.method ?? 'POST', headers: init.headers ?? { 'content-type': 'application/json' }, body });

  assert.equal((await handle({ method: 'GET', headers: {}, body: '' })).status, 405);
  assert.equal((await send('{}', { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await send('{'.padEnd(DEFAULT_MAX_BYTES + 1, ' '))).status, 413);
  assert.equal((await send('{oops')).status, 400);
  assert.equal((await send(JSON.stringify({ schema_version: 1 }))).status, 400);

  const accepted = await send(JSON.stringify(event()));
  assert.equal(accepted.status, 202);
  assert.deepEqual(accepted.body, { accepted: true });
  assert.equal(store.size(), 1);

  const stored = store.all()[0];
  assert.equal('ip' in stored, false);
  assert.equal('user_agent' in stored, false);
});

test('duplicate event ids are accepted without storing twice', async () => {
  const store = createMemoryStore();
  const handle = createHandler({ store });
  const payload = JSON.stringify(event());
  assert.equal((await handle({ method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: payload })).status, 202);
  assert.equal((await handle({ method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })).status, 202);
  assert.equal(store.size(), 1);
});

test('storage failure is a generic 500 and logs no payload', async () => {
  const codes = [];
  const handle = createHandler({
    store: { insert: async () => { throw new Error('connection refused for 1.2.3.4'); } },
    onError: (info) => codes.push(info),
  });
  const response = await handle({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event()) });
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'storage_unavailable' });
  assert.deepEqual(codes, [{ code: 'store_unavailable' }]);
  assert.equal(JSON.stringify(codes).includes('1.2.3.4'), false);
});

test('sql store parameterizes and upserts on event_id', async () => {
  const calls = [];
  const store = createSqlStore(async (text, params) => { calls.push({ text, params }); return []; });
  await store.insert(validateEvent(event()).event);
  assert.match(calls[0].text, /on conflict \(event_id\) do nothing/);
  assert.equal(calls[0].params.length, COLUMNS.length);
  assert.equal(calls[0].params.some(value => typeof value === 'string' && value.includes('1.2.3.4')), false);
});

test('readBody stops at the cap instead of buffering everything', async () => {
  const big = Readable.from([Buffer.alloc(16), Buffer.alloc(16), Buffer.alloc(16)]);
  assert.deepEqual(await readBody(big, 32), { tooLarge: true });
  const ok = Readable.from([Buffer.from('{"a":1}')]);
  assert.deepEqual(await readBody(ok, 64), { text: '{"a":1}' });
});

test('node adapter maps handler results onto the response', async () => {
  const store = createMemoryStore();
  const respond = nodeAdapter(createHandler({ store }));
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(event()))]), { method: 'POST', headers: { 'content-type': 'application/json' } });
  let status; let headers = {}; let body = '';
  const res = { set statusCode(v) { status = v; }, get statusCode() { return status; }, setHeader(n, v) { headers[n] = v; }, end(chunk) { body = chunk; } };
  await respond(req, res);
  assert.equal(status, 202);
  assert.equal(headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(body), { accepted: true });
});

test('web adapter handles size, content type, and success paths', async () => {
  const store = createMemoryStore();
  const respond = webAdapter(createHandler({ store }));
  const request = (body, method = 'POST', contentType = 'application/json') => ({
    method,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(body)) : null), forEach: (fn) => fn(contentType, 'content-type') },
    text: async () => body,
  });
  assert.equal((await respond(request(''))).status, 400);
  assert.equal((await respond(request('', 'GET'))).status, 405);
  assert.equal((await respond(request(JSON.stringify(event()), 'POST', 'text/plain'))).status, 415);
  assert.equal((await respond(request('x'.repeat(DEFAULT_MAX_BYTES + 1)))).status, 413);
  assert.equal((await respond(request(JSON.stringify(event())))).status, 202);
  assert.equal(store.size(), 1);
});

test('funnel report computes ratios, weeks, and excludes CI by default', () => {
  const install = uuid(1);
  const second = uuid(2);
  const third = uuid(3);
  const rows = [
    event({ event: 'install', anonymous_install_id: install, version: '0.1.8' }),
    event({ event: 'activated', anonymous_install_id: install, version: '0.1.8' }),
    event({ event: 'first_success', anonymous_install_id: install, version: '0.1.8' }),
    event({ event: 'd7_retained', anonymous_install_id: install, version: '0.1.8' }),
    event({ event: 'weekly_active', anonymous_install_id: install, version: '0.1.8', week: '2026-09-14' }),
    event({ event: 'weekly_active', anonymous_install_id: install, version: '0.1.8', week: '2026-09-07' }),
    event({ event: 'install', anonymous_install_id: second, version: '0.1.8' }),
    event({ event: 'activated', anonymous_install_id: second, version: '0.1.8' }),
    event({ event: 'install', anonymous_install_id: third, version: '0.2.0' }),
    event({ event: 'feedback', anonymous_install_id: install, version: '0.1.8', feedback: 'positive' }),
    event({ event: 'feedback', anonymous_install_id: second, version: '0.1.8', feedback: 'negative' }),
    event({ event: 'install', anonymous_install_id: uuid(9), version: '0.1.8', ci: true }),
  ];
  const report = buildReport(rows);
  assert.equal(report.totals.ciExcluded, 1);
  assert.equal(report.totals.events, 11);
  assert.equal(report.totals.packages, 1);
  const entry = report.packages[0];
  assert.equal(entry.installs, 3);
  assert.equal(entry.activated, 2);
  assert.equal(entry.firstSuccess, 1);
  assert.equal(entry.d7Retained, 1);
  assert.equal(entry.weeklyActive, 1);
  assert.equal(entry.activationRate, 66.7);
  assert.equal(entry.successRate, 50);
  assert.equal(entry.d7Rate, 100);
  assert.deepEqual(entry.feedback, { positive: 1, neutral: 0, negative: 1 });
  assert.deepEqual(entry.weeks.map(w => w.week), ['2026-09-07', '2026-09-14']);
  assert.equal(entry.versions.find(v => v.version === '0.2.0').installs, 1);
  assert.deepEqual(entry.versions.map(v => v.version), ['0.1.8', '0.2.0']);

  const withCi = buildReport(rows, { includeCi: true });
  assert.equal(withCi.totals.events, 12);
  assert.equal(withCi.packages[0].installs, 4);

  const markdown = renderMarkdown(report);
  assert.match(markdown, /# Telemetry funnel/);
  assert.match(markdown, /npm downloads include CI/);
  assert.equal(renderMarkdown(buildReport([])).includes('(no events)'), true);
});

test('funnel rates stay null when a denominator is zero, and parse both shapes', () => {
  const onlyInstall = buildReport([event({ event: 'install' })]);
  // A real zero numerator is 0%; null is reserved for a missing denominator.
  assert.equal(onlyInstall.packages[0].activationRate, 0);
  assert.equal(onlyInstall.packages[0].d7Rate, null);

  const asArray = parseEvents(JSON.stringify([event({ event: 'install' })]));
  assert.equal(asArray.length, 1);
  const asJsonl = parseEvents([event({ event: 'install' }), event({ event: 'activated', event_id: uuid(77) })].map(row => JSON.stringify(row)).join('\n'));
  assert.equal(asJsonl.length, 2);
  assert.equal(asJsonl[0].installId, uuid(1));
});

// The collector must accept exactly what the shipped SDK produces: capture the
// real payload the client would POST, then run it through the collector's own
// validation. This is the contract test between the two halves.
test('collector accepts the payload the shipped SDK actually sends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-contract-'));
  const sent = [];
  const original = https.request;
  try {
    https.request = (_url, _options, callback) => {
      const req = new EventEmitter();
      req.destroy = () => { queueMicrotask(() => req.emit('close')); return req; };
      req.end = (body) => { sent.push(JSON.parse(body)); queueMicrotask(callback); };
      return req;
    };
    syncBuiltinESMExports();

    const client = createTelemetry({
      package: 'pi-debug-mode',
      version: '0.1.8',
      endpoint: 'https://collector.example/events',
      collectorPrivacyAcknowledged: true,
      enabled: true,
      // Deterministic on every host: real CI sets CI=true, where the SDK would
      // otherwise suppress events and this contract test would capture nothing.
      allowCI: true,
      stateDirectory: join(dir, 'state'),
      features: ['debug'],
    });
    await client.install();
    await client.activated('debug');
    await client.success('debug');
    await client.active('debug');
    await client.feedback('positive', 'debug');

    assert.ok(sent.length >= 4, `expected several events, got ${sent.length}`);
    const accepted = [];
    for (const payload of sent) {
      const result = validateEvent(payload);
      assert.equal(result.ok, true, `collector rejected SDK payload: ${result.error} :: ${JSON.stringify(payload)}`);
      accepted.push(result.event);
    }
    assert.ok(accepted.some(row => row.event === 'install'));
    assert.ok(accepted.some(row => row.event === 'first_success'));
    assert.ok(accepted.some(row => row.event === 'feedback' && row.feedback === 'positive'));

    const store = createMemoryStore();
    const handle = createHandler({ store });
    for (const payload of sent) {
      const response = await handle({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      assert.equal(response.status, 202, JSON.stringify(response.body));
    }
    assert.equal(store.size(), sent.length);
    assert.equal(JSON.stringify(store.all()).includes('collector.example'), false);
  } finally {
    https.request = original;
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test('neon adapter targets the https SQL endpoint and keeps the string in a header', async () => {
  const calls = [];
  const query = createNeonQuery({
    connectionString: 'postgresql://user:secret@ep-cool-1.us-east-2.aws.neon.tech/neondb?sslmode=require',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ rows: [{ ok: 1 }] }) }; },
  });
  const rows = await query('select $1::text', ['a']);
  assert.deepEqual(rows, [{ ok: 1 }]);
  assert.equal(calls[0].url, 'https://ep-cool-1.us-east-2.aws.neon.tech/sql');
  assert.equal(calls[0].init.headers['neon-connection-string'].includes('secret'), true);
  assert.equal(calls[0].url.includes('secret'), false);
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'select $1::text', params: ['a'] });
});

test('neon adapter fails closed without a connection string and leaks no body on error', async () => {
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.throws(() => createNeonQuery({}), /DATABASE_URL/);
  } finally {
    if (original !== undefined) process.env.DATABASE_URL = original;
  }

  const query = createNeonQuery({
    connectionString: 'postgres://u:p@host.example/db',
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ message: 'row violates constraint for 1.2.3.4' }) }),
  });
  await assert.rejects(() => query('insert into t values ($1)', ['x']), (error) => {
    assert.equal(error.message, 'neon http 500');
    assert.equal(error.message.includes('1.2.3.4'), false);
    return true;
  });

  assert.equal(sqlEndpoint('postgres://u:p@host.example:5432/db?sslmode=require'), 'https://host.example:5432/sql');
  assert.throws(() => sqlEndpoint('https://host.example/db'), /postgres/);
  assert.throws(() => sqlEndpoint('mysql://u:p@host.example/db'), /postgres/);
});

test('aggregate snapshot exposes counts and rates but no install identifiers', async () => {
  const query = async (sql, params) => {
    assert.match(sql, /count\(distinct anonymous_install_id\)/);
    assert.deepEqual(params, []);
    return [{
      package: 'pi-debug-mode', version: '0.1.9', distinct_installs: '3',
      installs: '3', activated: '2', first_success: '1', d7_retained: '0',
      weekly_active: '2', feedback_positive: '1', feedback_neutral: '0', feedback_negative: '0',
    }];
  };
  const snapshot = await buildAggregateSnapshot(query);
  assert.equal(snapshot.privacy, 'aggregate_only_no_identifiers');
  assert.equal(snapshot.packages[0].distinct_installs, 3);
  assert.equal(snapshot.packages[0].conversion.install_to_activated, 2 / 3);
  assert.equal(snapshot.packages[0].conversion.activated_to_first_success, 1 / 2);
  assert.equal(snapshot.totals.installs, 3);
  assert.equal(JSON.stringify(snapshot).includes('anonymous_install_id'), false);
  assert.equal(JSON.stringify(snapshot).includes('event_id'), false);
});

test('vercel entry point exists and fails closed when storage is unconfigured', async () => {
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const module = await import(`../api/events.mjs?fresh=${Math.random()}`);
    const respond = module.default;
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(event()))]), { method: 'POST', headers: { 'content-type': 'application/json' } });
    let status; let body = '';
    const res = { set statusCode(v) { status = v; }, get statusCode() { return status; }, setHeader() {}, end(chunk) { body = chunk; } };
    await respond(req, res);
    assert.equal(status, 500);
    assert.deepEqual(JSON.parse(body), { error: 'storage_unavailable' });

    const getReq = Object.assign(Readable.from(['']), { method: 'GET', headers: {} });
    const getRes = { set statusCode(v) { status = v; }, get statusCode() { return status; }, setHeader() {}, end() {} };
    await respond(getReq, getRes);
    assert.equal(status, 405);
  } finally {
    if (original !== undefined) process.env.DATABASE_URL = original;
  }
});

test('PI_TELEMETRY_DEBUG prints the payload, sends nothing, and consumes no once-event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'telemetry-debug-'));
  const stateDir = join(dir, 'state');
  const captured = [];
  const network = [];
  const originalRequest = https.request;
  const originalWrite = process.stderr.write;
  https.request = ((url, options, callback) => {
    network.push(url);
    const req = new EventEmitter();
    req.destroy = () => { queueMicrotask(() => req.emit('close')); return req; };
    req.end = () => queueMicrotask(callback);
    return req;
  });
  syncBuiltinESMExports();
  process.stderr.write = ((chunk, ...rest) => {
    captured.push(String(chunk));
    return originalWrite.call(process.stderr, chunk, ...rest);
  });
  process.env.PI_TELEMETRY_DEBUG = '1';
  try {
    const client = createTelemetry({
      package: 'pi-debug-mode',
      version: '0.1.8',
      endpoint: 'https://collector.example/events',
      collectorPrivacyAcknowledged: true,
      enabled: true,
      allowCI: true,
      stateDirectory: stateDir,
      features: ['debug'],
    });
    await client.install();
    await client.activated('debug');
    await client.flush();

    const printed = captured.filter((line) => line.startsWith('[telemetry:debug] '));
    assert.equal(printed.length, 2, 'each pending event is printed once');
    const payloads = printed.map((line) => JSON.parse(line.replace('[telemetry:debug] ', '')));
    assert.deepEqual(payloads.map((p) => p.event), ['install', 'activated']);
    for (const payload of payloads) assert.equal(validateEvent(payload).ok, true);
    assert.deepEqual(network, [], 'debug mode must not touch the network');

    // Sending is disabled, but so is state: the events are still owed to the collector.
    const stateFiles = await readdir(stateDir).catch(() => []);
    assert.deepEqual(stateFiles.filter((name) => name.endsWith('.json')), [], 'no state written in debug mode');
  } finally {
    https.request = originalRequest;
    syncBuiltinESMExports();
    process.stderr.write = originalWrite;
    delete process.env.PI_TELEMETRY_DEBUG;
    await rm(dir, { recursive: true, force: true });
  }
});


test('source snapshot groups installs by OS, Node major, package and cohort version without identifiers', async () => {
  const query = async (sql, params) => {
    assert.match(sql, /group by os, node_major, package, cohort_version/);
    assert.equal(params.length, 1);
    return [
      { os: 'darwin', node_major: 24, package: 'pi-debug-mode', version: '0.1.11', installs: '3', activated: '2', first_success: '1', d7_eligible: '0', d7_retained: '0', weekly_active: '2' },
      { os: 'linux', node_major: 22, package: 'pi-debug-mode', version: '0.1.11', installs: '1', activated: '1', first_success: '1', d7_eligible: '0', d7_retained: '0', weekly_active: '1' },
      { os: 'darwin', node_major: 24, package: 'pi-design-mode', version: '0.3.2', installs: '2', activated: '1', first_success: '0', d7_eligible: '0', d7_retained: '0', weekly_active: '1' },
    ];
  };
  const snapshot = await buildSourceSnapshot(query, { now: '2026-09-21T00:00:00.000Z' });
  assert.equal(snapshot.privacy, 'aggregate_only_no_identifiers');
  assert.equal(snapshot.totals.installs, 6);
  assert.deepEqual(snapshot.os.map(row => [row.os, row.installs]), [['darwin', 5], ['linux', 1]]);
  assert.deepEqual(snapshot.node_major.map(row => [row.node_major, row.installs]), [[24, 5], [22, 1]]);
  assert.equal(snapshot.rows[0].conversion.install_to_activated, 2 / 3);
  assert.equal(JSON.stringify(snapshot).includes('anonymous_install_id'), false);
  assert.equal(JSON.stringify(snapshot).includes('event_id'), false);
});
