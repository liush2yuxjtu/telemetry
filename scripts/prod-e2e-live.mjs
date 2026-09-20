import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelemetry } from '@nyn5255/telemetry';

const base = process.env.COLLECTOR_URL || 'https://telemetry-peach.vercel.app';
const client = String(process.env.E2E_CLIENT || process.platform)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, '-');
const packageName = `telemetry-e2e-${client}`;
const version = '0.1.2';

async function readJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, ok: response.ok, body };
}

const startedAt = new Date().toISOString();
const healthBefore = await readJson(`${base}/api/health`);
if (!healthBefore.ok) throw new Error(`collector health failed before send: ${healthBefore.status}`);

const stateDirectory = await mkdtemp(join(tmpdir(), `telemetry-e2e-${client}-`));
const telemetry = createTelemetry({
  package: packageName,
  version,
  enabled: true,
  endpoint: `${base}/api/events`,
  collectorPrivacyAcknowledged: true,
  features: ['smoke'],
  stateDirectory,
  timeoutMs: 1000,
  allowCI: true,
});

// The SDK deliberately unrefs sockets/timers so telemetry never keeps a CLI alive.
const keepAlive = setInterval(() => {}, 100);
try {
  await telemetry.install();
  await telemetry.activated('smoke');
  await telemetry.success('smoke');
  await telemetry.feedback('positive', 'smoke');
  await telemetry.flush();
} finally {
  clearInterval(keepAlive);
}

const healthAfter = await readJson(`${base}/api/health`);
if (!healthAfter.ok) throw new Error(`collector health failed after send: ${healthAfter.status}`);
const funnelAfter = await readJson(`${base}/api/funnel`);
if (!funnelAfter.ok) throw new Error(`funnel read failed: ${funnelAfter.status}`);
const leakedTestRows = Array.isArray(funnelAfter.body?.packages)
  ? funnelAfter.body.packages.filter(row => String(row?.package || '').startsWith('telemetry-e2e-'))
  : [];
if (leakedTestRows.length) throw new Error('CI-tagged E2E events leaked into the real-user funnel');

console.log(JSON.stringify({
  sdk: '@nyn5255/telemetry@0.1.2',
  package: packageName,
  platform: process.platform,
  node: process.versions.node,
  ci: Boolean(process.env.GITHUB_ACTIONS || process.env.CI),
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  expected_events: ['install', 'activated', 'first_success', 'weekly_active', 'feedback'],
  health_before: healthBefore,
  health_after: healthAfter,
  funnel_after: {
    status: funnelAfter.status,
    ok: funnelAfter.ok,
    privacy: funnelAfter.body?.privacy,
    totals: funnelAfter.body?.totals,
    e2e_rows_visible: leakedTestRows.length,
  },
  note: 'Event delivery is verified against Vercel request logs; CI-tagged E2E rows must remain absent from the real-user funnel.'
}, null, 2));
