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

await telemetry.install();
await telemetry.activated('smoke');
await telemetry.success('smoke');
await telemetry.feedback('positive', 'smoke');
await telemetry.flush();

const healthAfter = await readJson(`${base}/api/health`);
if (!healthAfter.ok) throw new Error(`collector health failed after send: ${healthAfter.status}`);

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
  note: 'Event delivery is verified against Vercel request logs after all lanes complete; SDK calls are best-effort by design.'
}, null, 2));
