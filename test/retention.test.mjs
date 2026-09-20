import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COUNT_SQL, DELETE_SQL, RETENTION_DAYS, countExpired, deleteExpired, retentionCutoff } from '../collector/retention.mjs';

test('retention window is 180 days by default and computed from the injected clock', () => {
  assert.equal(RETENTION_DAYS, 180);
  const cutoff = retentionCutoff(180, new Date('2026-09-20T00:00:00.000Z'));
  assert.equal(cutoff, '2026-03-24T00:00:00.000Z');
  assert.equal(retentionCutoff(1, new Date('2026-01-02T00:00:00.000Z')), '2026-01-01T00:00:00.000Z');
});

test('retention refuses a nonsensical window instead of deleting everything', () => {
  for (const days of [0, -1, 1.5, 4000, NaN]) {
    assert.throws(() => retentionCutoff(days), /retention days/);
  }
});

test('retention deletes by the collector clock, never by a client timestamp', () => {
  assert.match(COUNT_SQL, /received_at < now\(\)/);
  assert.match(DELETE_SQL, /received_at < now\(\)/);
  assert.equal(/client_timestamp/.test(DELETE_SQL), false);
});

test('count and delete adapt to whatever the driver returns', async () => {
  const calls = [];
  const query = async (text, params) => {
    calls.push({ text, params });
    return text.startsWith('select') ? [{ expired: 7 }] : [{ count: 3 }];
  };
  assert.equal(await countExpired(query), 7);
  assert.equal(await deleteExpired(query), 3);
  assert.deepEqual(calls[0].params, [180]);

  const odd = async (text) => (text.startsWith('select') ? [] : undefined);
  assert.equal(await countExpired(odd), 0);
  assert.equal(await deleteExpired(odd), 0);
});
