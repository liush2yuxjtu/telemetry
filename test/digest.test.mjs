import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, formatDigestText, webhookBody } from '../collector/digest.mjs';

const rows = [
  { package: 'pi-debug-mode', event: 'install', installs: 10, window: 'current' },
  { package: 'pi-debug-mode', event: 'activated', installs: 6, window: 'current' },
  { package: 'pi-debug-mode', event: 'first_success', installs: 3, window: 'current' },
  { package: 'pi-debug-mode', event: 'd7_retained', installs: 1, window: 'current' },
  { package: 'pi-debug-mode', event: 'weekly_active', installs: 4, window: 'current' },
  { package: 'pi-debug-mode', event: 'install', installs: 7, window: 'previous' },
  { package: 'pi-debug-mode', event: 'weekly_active', installs: 2, window: 'previous' },
  { package: 'pi-design-mode', event: 'install', installs: 2, window: 'current' },
];

test('digest computes the funnel, deltas, and rates', () => {
  const digest = buildDigest(rows, { now: new Date('2026-09-18T01:00:00.000Z') });
  assert.equal(digest.windowDays, 30);
  assert.equal(digest.generatedAt, '2026-09-18T01:00:00.000Z');
  const debug = digest.packages.find((p) => p.package === 'pi-debug-mode');
  assert.equal(debug.installs, 10);
  assert.equal(debug.activated, 6);
  assert.equal(debug.activationRate, 60);
  assert.equal(debug.successRate, 50);
  assert.equal(debug.d7Rate, 33.3);
  assert.equal(debug.installsDelta, 3);
  assert.equal(debug.weeklyActive, 4);
  assert.equal(debug.weeklyActiveDelta, 2);
  // Sorted by installs, so the bigger package is first.
  assert.equal(digest.packages[0].package, 'pi-debug-mode');
  assert.equal(digest.totals.installs, 12);
  assert.equal(digest.totals.activationRate, 50);
  assert.match(digest.note, /Lower bounds/);
});

test('digest handles an empty window without inventing numbers', () => {
  const digest = buildDigest([]);
  assert.equal(digest.totals.installs, 0);
  assert.equal(digest.totals.activationRate, null);
  assert.deepEqual(digest.packages, []);
  assert.match(formatDigestText(digest), /No events in this window/);
});

test('digest text is compact and states the boundaries', () => {
  const text = formatDigestText(buildDigest(rows));
  assert.match(text, /installs 12 → activated 6 \(50%\)/);
  assert.match(text, /weekly active installs: 4/);
  assert.match(text, /pi-debug-mode: 10 installs \(\+3\)/);
  assert.match(text, /npm downloads include CI and are not users/);
});

test('webhook body matches the chat platform hosting the URL', () => {
  assert.deepEqual(webhookBody('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', 'hi', {}), {
    msgtype: 'text',
    text: { content: 'hi' },
  });
  assert.deepEqual(webhookBody('https://open.feishu.cn/open-apis/bot/v2/hook/x', 'hi', {}), {
    msg_type: 'text',
    content: { text: 'hi' },
  });
  assert.deepEqual(webhookBody('https://example.com/hook', 'hi', { totals: 1 }), { text: 'hi', digest: { totals: 1 } });
  assert.deepEqual(webhookBody('not a url', 'hi', {}), { text: 'hi', digest: {} });
});
