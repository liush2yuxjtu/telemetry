/**
 * Daily funnel digest.
 *
 * Pure aggregation so it can be tested without a database: feed it per-package,
 * per-event counts for the current and previous window and it produces the
 * conversion chain, the week-over-week deltas, and a short message body.
 *
 * Boundaries are stated in the output, not implied: these are opt-in install ids
 * with at-most-once delivery, so every number is a lower bound and the digest
 * says so instead of presenting them as user counts.
 */

export const STEPS = ['install', 'activated', 'first_success', 'd7_retained'];

function rate(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function pct(value) {
  return value === null ? 'n/a' : `${value}%`;
}

function signed(value) {
  if (value === null || value === undefined) return 'new';
  return value >= 0 ? `+${value}` : String(value);
}

/**
 * @param {Array<{package: string, event: string, window: 'current'|'previous', installs: number, weekly_active?: number}>} rows
 * @param {{windowDays?: number, now?: Date}} [options]
 */
export function buildDigest(rows, options = {}) {
  const windowDays = options.windowDays ?? 30;
  const now = options.now ?? new Date();
  const packages = new Map();

  const ensure = (name) => {
    if (!packages.has(name)) {
      packages.set(name, {
        package: name,
        current: Object.fromEntries(STEPS.map((step) => [step, 0])),
        previous: Object.fromEntries(STEPS.map((step) => [step, 0])),
        weeklyActive: 0,
        previousWeeklyActive: 0,
      });
    }
    return packages.get(name);
  };

  for (const row of rows) {
    const entry = ensure(row.package);
    const bucket = row.window === 'previous' ? 'previous' : 'current';
    const count = Number(row.installs ?? 0);
    if (row.event === 'weekly_active') {
      if (bucket === 'current') entry.weeklyActive += count;
      else entry.previousWeeklyActive += count;
      continue;
    }
    if (!STEPS.includes(row.event)) continue;
    entry[bucket][row.event] += count;
  }

  const list = [...packages.values()].map((entry) => ({
    package: entry.package,
    installs: entry.current.install,
    activated: entry.current.activated,
    firstSuccess: entry.current.first_success,
    d7Retained: entry.current.d7_retained,
    weeklyActive: entry.weeklyActive,
    activationRate: rate(entry.current.activated, entry.current.install),
    successRate: rate(entry.current.first_success, entry.current.activated),
    d7Rate: rate(entry.current.d7_retained, entry.current.first_success),
    installsDelta: entry.current.install - entry.previous.install,
    activatedDelta: entry.current.activated - entry.previous.activated,
    firstSuccessDelta: entry.current.first_success - entry.previous.first_success,
    weeklyActiveDelta: entry.weeklyActive - entry.previousWeeklyActive,
  })).sort((a, b) => b.installs - a.installs);

  const totals = list.reduce((acc, entry) => ({
    installs: acc.installs + entry.installs,
    activated: acc.activated + entry.activated,
    firstSuccess: acc.firstSuccess + entry.firstSuccess,
    d7Retained: acc.d7Retained + entry.d7Retained,
    weeklyActive: acc.weeklyActive + entry.weeklyActive,
  }), { installs: 0, activated: 0, firstSuccess: 0, d7Retained: 0, weeklyActive: 0 });

  return {
    generatedAt: now.toISOString(),
    windowDays,
    totals: {
      ...totals,
      activationRate: rate(totals.activated, totals.installs),
      successRate: rate(totals.firstSuccess, totals.activated),
      d7Rate: rate(totals.d7Retained, totals.firstSuccess),
    },
    packages: list,
    note: 'Lower bounds: opt-in install ids with at-most-once delivery. npm downloads include CI and are not users.',
  };
}

/** Compact message body, sized for a chat webhook. */
export function formatDigestText(digest) {
  const lines = [
    `Pi telemetry funnel — last ${digest.windowDays} days`,
    `installs ${digest.totals.installs} → activated ${digest.totals.activated} (${pct(digest.totals.activationRate)}) → first success ${digest.totals.firstSuccess} (${pct(digest.totals.successRate)}) → d7 ${digest.totals.d7Retained} (${pct(digest.totals.d7Rate)})`,
    `weekly active installs: ${digest.totals.weeklyActive}`,
  ];
  for (const entry of digest.packages.slice(0, 12)) {
    lines.push(
      `${entry.package}: ${entry.installs} installs (${signed(entry.installsDelta)}), ${entry.activated} activated (${pct(entry.activationRate)}), ${entry.firstSuccess} success, d7 ${entry.d7Retained}`,
    );
  }
  if (!digest.packages.length) lines.push('No events in this window.');
  lines.push(digest.note);
  return lines.join('\n');
}

/** Webhook body for the common chat bots, keyed by host so no extra config is needed. */
export function webhookBody(url, text, digest) {
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    return { text, digest };
  }
  if (host.endsWith('qyapi.weixin.qq.com')) return { msgtype: 'text', text: { content: text } };
  if (host.endsWith('open.feishu.cn') || host.endsWith('feishu.cn')) return { msg_type: 'text', content: { text } };
  return { text, digest };
}
