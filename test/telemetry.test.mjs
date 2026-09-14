import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelemetry } from '../dist/index.js';
let dir, sent, behavior, oldRequest, oldNow, keepAlive, onSend;
const originalEnv = { ...process.env };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'telemetry-test-'));
  sent = []; onSend = undefined; behavior = 'ok'; oldRequest = https.request; oldNow = Date.now;
  for (const k of ['CI','GITHUB_ACTIONS','GITLAB_CI','TF_BUILD','JENKINS_URL','BUILD_ID','DO_NOT_TRACK','PI_TELEMETRY_DISABLED']) delete process.env[k];
  keepAlive = setInterval(() => {}, 1000);
  https.request = (url, options, callback) => {
    if (behavior === 'throw') throw Error('offline');
    const req = new EventEmitter();
    req.destroy = () => { queueMicrotask(() => req.emit('close')); return req; };
    req.end = body => { sent.push({ url, options, body: JSON.parse(body) }); onSend?.(); if (behavior === 'ok') queueMicrotask(callback); };
    return req;
  };
  syncBuiltinESMExports();
});
afterEach(async () => {
  clearInterval(keepAlive); https.request = oldRequest; Date.now = oldNow; syncBuiltinESMExports();
  process.env = { ...originalEnv }; await rm(dir, { recursive: true, force: true });
});
const client = (extra = {}) => createTelemetry({ package: 'pi-debug-mode', version: '0.1.8', endpoint: 'https://collector.example/events', collectorPrivacyAcknowledged: true, enabled: true, stateDirectory: join(dir, 'state'), features: ['debug'], ...extra });
const names = () => sent.map(x => x.body.event);
const stateFile = async () => join(dir, 'state', (await readdir(join(dir, 'state'))).find(x => x.endsWith('.json')));
test('default opt-out, kill switches, missing endpoint/privacy acknowledgement and CI do no IO', async () => {
  for (const extra of [{ enabled: undefined }, { endpoint: undefined }, { collectorPrivacyAcknowledged: false }]) await client(extra).success();
  for (const key of ['DO_NOT_TRACK', 'PI_TELEMETRY_DISABLED', 'CI']) { process.env[key] = '1'; await client().install(); delete process.env[key]; }
  assert.deepEqual(sent, []); assert.deepEqual(await readdir(dir), []);
});
test('explicit CI permission includes only boolean CI', async () => { process.env.CI = 'true'; await client({ allowCI: true }).install(); assert.equal(sent[0].body.ci, true); });
test('six events, first success once across clients and versions, stable private UUID', async () => {
  const c = client(); await c.install(); await c.install(); await c.activated('debug'); await c.activated(); await c.success('debug');
  await client({ version: '0.1.9' }).success(); await c.feedback('positive', 'debug');
  assert.deepEqual(names(), ['install', 'activated', 'first_success', 'weekly_active', 'feedback']);
  assert.equal(new Set(sent.map(x => x.body.anonymous_install_id)).size, 1);
  assert.equal(new Set(sent.map(x => x.body.event_id)).size, sent.length);
  if (process.platform !== 'win32') assert.equal((await stat(await stateFile())).mode & 0o777, 0o600);
});
test('D7 fires only in [7 days,8 days), once; natural UTC week rolls over year', async () => {
  const t = Date.parse('2026-12-27T23:59:59Z'); Date.now = () => t;
  const c = client(); await c.success();
  Date.now = () => t + 6 * 86400000; await c.success(); assert.equal(names().includes('d7_retained'), false);
  Date.now = () => t + 7 * 86400000; await c.success(); await client().success();
  assert.equal(names().filter(x => x === 'd7_retained').length, 1);
  assert.deepEqual(sent.filter(x => x.body.week).map(x => x.body.week), ['2026-12-21', '2026-12-28']);
  Date.now = () => t + 8 * 86400000; await c.success();
  assert.equal(sent.at(-1).body.week, '2027-01-04');
});
test('missed D7 window is not counted retroactively', async () => {
  const t = Date.now(); Date.now = () => t; const c = client(); await c.success();
  Date.now = () => t + 8 * 86400000; await c.success(); assert.equal(names().includes('d7_retained'), false);
});
test('different packages never share IDs', async () => { await client().install(); await client({ package: 'pi-subtask' }).install(); assert.notEqual(sent[0].body.anonymous_install_id, sent[1].body.anonymous_install_id); });
test('concurrent clients share lock and never duplicate an install', async () => {
  await Promise.all(Array.from({ length: 20 }, () => client().install())); assert.deepEqual(names(), ['install']);
});
test('no arbitrary properties, paths, text, query credentials or undeclared features', async () => {
  await client().success('/private/repo'); await client().feedback('my prompt');
  for (const endpoint of ['http://example.com', 'https://user:secret@example.com', 'https://example.com?user=alice']) await client({ endpoint }).install();
  await client({ version: '1.0.0-private-repo' }).install(); assert.equal(sent.length, 0);
  await client().feedback('negative', 'debug');
  assert.deepEqual(Object.keys(sent[0].body).sort(), ['schema_version','event','event_id','anonymous_install_id','package','version','timestamp','os','node_major','ci','feature','feedback'].sort());
  assert.deepEqual(Object.keys(sent[0].options.headers).sort(), ['content-length','content-type']);
});
test('failures never reject and once events do not retry', async () => {
  behavior = 'throw'; await client().install(); behavior = 'ok'; await client().install(); assert.equal(sent.length, 0);
});
test('wall-clock deadline bounds stalled network and disable cancels requests', async () => {
  behavior = 'stall'; const c = client({ timeoutMs: 50 }); const started = performance.now(); await c.install();
  assert.ok(performance.now() - started < 400);
  onSend = () => queueMicrotask(() => c.disable());
  await c.feedback('positive'); await c.success();
  assert.deepEqual(names(), ['install','feedback']);
});
test('runtime environment opt-out and disable suppress queued events', async () => {
  const c = client(); c.disable(); await c.install(); process.env.DO_NOT_TRACK = '1'; await client().success(); assert.equal(sent.length, 0);
});
test('malformed state and filesystem errors fail closed', async () => {
  await client().install(); const file = await stateFile(); await writeFile(file, '{invalid'); await client().success(); assert.deepEqual(names(), ['install']);
  await writeFile(join(dir,'not-a-directory'), 'x'); await client({ stateDirectory: join(dir,'not-a-directory') }).install();
});
test('crash left lock is skipped without waiting or changing identity', async () => {
  await client().install(); await mkdir((await stateFile()) + '.lock'); await client().success(); assert.deepEqual(names(), ['install']);
});
test('bounded queue drops excess calls', async () => {
  const c = client(); await Promise.all(Array.from({ length: 100 }, () => c.feedback('neutral'))); assert.equal(sent.length, 32); await c.flush();
});
