import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAggregateSnapshot } from '../collector/report.mjs';
import { parseFunnelOptions } from '../api/funnel.mjs';

test('aggregate funnel is cohort-shaped, D7 uses only eligible first-success installs', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('orphan_activated')) {
      return [{ orphan_activated: '1', orphan_first_success: '2', test_events_excluded: '8' }];
    }
    assert.match(sql, /distinct on \(anonymous_install_id, package\)/);
    assert.match(sql, /version as cohort_version/);
    assert.match(sql, /first_success_at <= \$4::timestamptz - interval '8 days'/);
    return [{
      package: 'pi-debug-mode',
      version: '0.1.12',
      distinct_installs: '3',
      installs: '3',
      activated: '1',
      first_success: '1',
      d7_eligible: '0',
      d7_retained: '0',
      weekly_active: '1',
      feedback_positive: '0',
      feedback_neutral: '0',
      feedback_negative: '0',
    }];
  };

  const now = new Date('2026-09-21T06:00:00.000Z');
  const snapshot = await buildAggregateSnapshot(query, {
    packageName: 'pi-debug-mode',
    version: '0.1.12',
    now,
  });

  assert.equal(snapshot.schema_version, 2);
  assert.equal(snapshot.cohorting, 'first_install_version');
  assert.deepEqual(calls[0].params, ['pi-debug-mode', '0.1.12', false, now.toISOString()]);
  assert.deepEqual(calls[1].params, ['pi-debug-mode', false]);
  assert.equal(snapshot.packages[0].conversion.install_to_activated, 1 / 3);
  assert.equal(snapshot.packages[0].conversion.activated_to_first_success, 1);
  assert.equal(snapshot.packages[0].conversion.first_success_to_d7_retained, null);
  assert.equal(snapshot.packages[0].d7_eligible, 0);
  assert.deepEqual(snapshot.diagnostics, {
    orphan_activated: 1,
    orphan_first_success: 2,
    test_events_excluded: 8,
  });
});

test('D7 conversion cannot use immature first-success cohorts', async () => {
  let call = 0;
  const query = async () => {
    call++;
    if (call === 2) return [{}];
    return [{
      package: 'pi-debug-mode', version: '0.1.11',
      distinct_installs: 4, installs: 4, activated: 4, first_success: 3,
      d7_eligible: 2, d7_retained: 1, weekly_active: 3,
      feedback_positive: 0, feedback_neutral: 0, feedback_negative: 0,
    }];
  };
  const snapshot = await buildAggregateSnapshot(query, { now: '2026-09-30T00:00:00Z' });
  assert.equal(snapshot.packages[0].conversion.first_success_to_d7_retained, 0.5);
  assert.ok(snapshot.packages[0].activated <= snapshot.packages[0].installs);
  assert.ok(snapshot.packages[0].first_success <= snapshot.packages[0].activated);
  assert.ok(snapshot.packages[0].d7_retained <= snapshot.packages[0].d7_eligible);
});

test('funnel query parser supports package/version filters and keeps test traffic opt-in', () => {
  assert.deepEqual(
    parseFunnelOptions({ url: '/api/funnel?package=pi-subtask&version=1.2.3' }),
    { packageName: 'pi-subtask', version: '1.2.3', includeTest: false },
  );
  assert.deepEqual(
    parseFunnelOptions({ url: '/api/funnel?package=telemetry-smoke&include_test=1' }),
    { packageName: 'telemetry-smoke', version: null, includeTest: true },
  );
  assert.throws(() => parseFunnelOptions({ url: '/api/funnel?package=Bad%20Name' }), /invalid package/);
  assert.throws(() => parseFunnelOptions({ url: '/api/funnel?version=latest' }), /invalid version/);
  assert.throws(() => parseFunnelOptions({ url: '/api/funnel?include_test=yes' }), /invalid include_test/);
});
