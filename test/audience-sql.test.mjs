// Runs the real aggregate SQL against Postgres. Skipped unless TEST_PG_URL is set
// (e.g. postgres://user:pass@127.0.0.1/db); requires the `psql` CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildAggregateSnapshot } from '../collector/report.mjs';
import { buildSourceSnapshot } from '../collector/source-report.mjs';

const url = process.env.TEST_PG_URL;
const psql = sql => execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-qAt'], { input: sql, encoding: 'utf8' });

const literal = value => {
  if (value === null || value === undefined) return 'NULL';
  if (Array.isArray(value)) return `'{${value.map(v => `"${v}"`).join(',')}}'`;
  if (typeof value === 'boolean') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
};

// Test-only adapter: inline parameters, return rows as JSON.
const query = async (text, params) => {
  let sql = text;
  for (let i = params.length; i >= 1; i--) sql = sql.replaceAll(`$${i}`, literal(params[i - 1]));
  return JSON.parse(psql(`select coalesce(json_agg(q), '[]') from (${sql}) q;`));
};

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let seq = 0;
const row = (install, event, version, os, node, at, extra = {}) => ({
  event_id: `e${++seq}`, schema_version: 1, event, anonymous_install_id: id(install), package: extra.package ?? 'pi-debug-mode',
  version, client_timestamp: at, os, node_major: node, ci: extra.ci ?? false, received_at: at,
});

// Mirrors the production shape: 14 non-CI installs, 4 activated, 2 first_success.
const EVENTS = [
  // owner's Mac, full funnel (registered as internal)
  row(1, 'install', '0.1.11', 'darwin', 24, '2026-09-20T04:00:00Z'),
  row(1, 'activated', '0.1.11', 'darwin', 24, '2026-09-20T04:01:00Z'),
  row(1, 'first_success', '0.1.11', 'darwin', 24, '2026-09-20T04:02:00Z'),
  row(2, 'install', '0.1.11', 'darwin', 26, '2026-09-20T05:30:00Z'),
  row(2, 'activated', '0.1.11', 'darwin', 26, '2026-09-20T05:31:00Z'),
  row(2, 'first_success', '0.1.11', 'darwin', 26, '2026-09-20T05:32:00Z'),
  // win32 Node 22/24/26 within six minutes: a test matrix
  row(3, 'install', '0.1.12', 'win32', 22, '2026-09-23T10:00:00Z'),
  row(4, 'install', '0.1.12', 'win32', 24, '2026-09-23T10:03:00Z'),
  row(5, 'install', '0.1.12', 'win32', 26, '2026-09-23T10:06:00Z'),
  // spread-out installs: kept
  row(6, 'install', '0.1.12', 'linux', 24, '2026-09-21T01:00:00Z'),
  row(6, 'activated', '0.1.12', 'linux', 24, '2026-09-21T01:10:00Z'),
  row(7, 'install', '0.1.12', 'linux', 24, '2026-09-22T08:00:00Z'),
  row(8, 'install', '0.1.12', 'linux', 24, '2026-09-24T12:00:00Z'),
  row(9, 'install', '0.1.12', 'linux', 24, '2026-09-25T16:00:00Z'),
  row(10, 'install', '0.1.12', 'android', 26, '2026-09-22T03:00:00Z'),
  row(11, 'install', '0.1.12', 'darwin', 26, '2026-09-21T09:00:00Z'),
  row(12, 'install', '0.1.12', 'darwin', 26, '2026-09-26T09:00:00Z'),
  row(13, 'install', '0.1.12', 'darwin', 22, '2026-09-21T14:00:00Z'),
  row(13, 'activated', '0.1.12', 'darwin', 22, '2026-09-21T14:05:00Z'),
  row(14, 'install', '0.1.9', 'linux', 22, '2026-09-19T02:00:00Z'),
  // never counted
  row(15, 'install', '0.1.12', 'linux', 24, '2026-09-23T10:01:00Z', { ci: true }),
  row(16, 'install', '0.1.0', 'linux', 24, '2026-09-23T10:02:00Z', { package: 'telemetry-smoke' }),
];

const now = '2026-09-27T06:00:00Z';
const internalIds = [id(1), id(2)];

test('audience filter on real Postgres', { skip: !url && 'TEST_PG_URL not set' }, async () => {
  psql(`drop table if exists telemetry_events cascade; drop table if exists debug_feedback cascade;\n${readFileSync(new URL('../collector/schema.sql', import.meta.url), 'utf8')}`);
  const cols = Object.keys(EVENTS[0]);
  psql(`insert into telemetry_events (${cols.join(',')}) values ${EVENTS.map(e => `(${cols.map(c => literal(e[c])).join(',')})`).join(',\n')};`);

  const all = await buildAggregateSnapshot(query, { now, internalIds });
  assert.deepEqual([all.totals.installs, all.totals.activated, all.totals.first_success], [14, 4, 2]);
  assert.equal(all.filters.audience, 'all');
  assert.equal(all.diagnostics.audience_excluded_installs, null);

  const human = await buildAggregateSnapshot(query, { now, internalIds, audience: 'likely_human' });
  assert.deepEqual([human.totals.installs, human.totals.activated, human.totals.first_success], [9, 2, 0]);
  assert.deepEqual(human.diagnostics.audience_excluded_installs, { matrix_burst: 3, internal: 2 });
  assert.equal(JSON.stringify(human).includes(id(1)), false);

  const noIds = await buildAggregateSnapshot(query, { now, internalIds: [], audience: 'likely_human' });
  assert.equal(noIds.totals.installs, 11);

  const scoped = await buildAggregateSnapshot(query, { now, internalIds, audience: 'likely_human', packageName: 'pi-debug-mode', version: '0.1.12' });
  assert.deepEqual([scoped.totals.installs, scoped.totals.activated], [8, 2]);

  const sources = await buildSourceSnapshot(query, { now, internalIds, audience: 'likely_human' });
  assert.equal(sources.totals.installs, 9);
  assert.equal(sources.os.find(o => o.os === 'win32'), undefined);
  assert.equal(sources.audience, 'likely_human');
  const sourcesAll = await buildSourceSnapshot(query, { now, internalIds });
  assert.equal(sourcesAll.totals.installs, 14);
});
