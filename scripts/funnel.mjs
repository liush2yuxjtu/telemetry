#!/usr/bin/env node
/**
 * Product funnel report for the opt-in telemetry stream.
 *
 *   psql "$DATABASE_URL" -At -f collector/export.sql > events.json
 *   node scripts/funnel.mjs --events events.json
 *   node scripts/funnel.mjs --events events.json --json
 *
 * Reads an exported event array (or JSONL on stdin) and computes the funnel the
 * SDK defines: install -> activated -> first_success -> d7_retained, with
 * weekly_active as the engagement measure and feedback as the only qualitative
 * signal. No network, no database driver, no dependencies.
 *
 * Boundaries this report states rather than hides:
 *   - Every denominator counts opt-in install ids only. npm downloads include
 *     CI, mirrors and reinstalls, so downloads are not users and never divide
 *     anything here.
 *   - CI rows are excluded by default; the client also suppresses them unless a
 *     package explicitly opts into allowCI.
 *   - A once event is at-most-once, not guaranteed delivery, so counts are
 *     lower bounds.
 */

import { readFileSync } from 'node:fs';

const STEPS = ['install', 'activated', 'first_success', 'd7_retained'];

export function parseEvents(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return [];
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array of events');
    return parsed.map(normalize);
  }
  return text.split('\n').filter(Boolean).map(line => normalize(JSON.parse(line)));
}

function normalize(row) {
  return {
    event: row.event,
    event_id: row.event_id,
    installId: row.anonymous_install_id ?? row.installId,
    package: row.package,
    version: row.version,
    timestamp: row.timestamp ?? row.client_timestamp,
    os: row.os,
    nodeMajor: row.node_major ?? row.nodeMajor,
    ci: row.ci === true || row.ci === 'true',
    feature: row.feature ?? null,
    week: row.week ?? null,
    feedback: row.feedback ?? null,
  };
}

export function buildReport(rawEvents, options = {}) {
  const includeCi = options.includeCi === true;
  const rows = rawEvents.map(normalize);
  const ciExcluded = rows.filter(row => row.ci).length;
  const events = includeCi ? rows : rows.filter(row => !row.ci);

  const byPackage = new Map();
  for (const event of events) {
    if (!byPackage.has(event.package)) {
      byPackage.set(event.package, {
        package: event.package,
        steps: Object.fromEntries(STEPS.map(step => [step, new Set()])),
        weeklyActive: new Set(),
        weekly: new Map(),
        feedback: { positive: 0, neutral: 0, negative: 0 },
        versions: new Map(),
        events: 0,
      });
    }
    const entry = byPackage.get(event.package);
    entry.events++;
    if (STEPS.includes(event.event)) entry.steps[event.event].add(event.installId);
    if (event.event === 'weekly_active') {
      entry.weeklyActive.add(event.installId);
      if (event.week) entry.weekly.set(event.week, (entry.weekly.get(event.week) ?? 0) + 1);
    }
    if (event.event === 'feedback' && event.feedback in entry.feedback) entry.feedback[event.feedback]++;
    const versionKey = event.version ?? 'unknown';
    if (!entry.versions.has(versionKey)) {
      entry.versions.set(versionKey, Object.fromEntries(STEPS.map(step => [step, new Set()])));
    }
    if (STEPS.includes(event.event)) entry.versions.get(versionKey)[event.event].add(event.installId);
  }

  const packages = [...byPackage.values()].map(entry => {
    const counts = Object.fromEntries(STEPS.map(step => [step, entry.steps[step].size]));
    const weeklyActive = entry.weeklyActive.size;
    return {
      package: entry.package,
      events: entry.events,
      installs: counts.install,
      activated: counts.activated,
      firstSuccess: counts.first_success,
      d7Retained: counts.d7_retained,
      weeklyActive,
      activationRate: rate(counts.activated, counts.install),
      successRate: rate(counts.first_success, counts.activated),
      d7Rate: rate(counts.d7_retained, counts.first_success),
      weeklyShare: rate(weeklyActive, counts.install),
      feedback: entry.feedback,
      weeks: [...entry.weekly.entries()].sort().slice(-8).map(([week, count]) => ({ week, count })),
      versions: [...entry.versions.entries()].map(([version, steps]) => ({
        version,
        installs: steps.install.size,
        activated: steps.activated.size,
        firstSuccess: steps.first_success.size,
        d7Retained: steps.d7_retained.size,
      })).sort((a, b) => b.installs - a.installs),
    };
  }).sort((a, b) => b.installs - a.installs);

  const timestamps = events.map(row => row.timestamp).filter(Boolean).sort();
  return {
    window: { from: timestamps[0] ?? null, to: timestamps.at(-1) ?? null },
    totals: {
      events: events.length,
      ciExcluded,
      packages: packages.length,
      installs: packages.reduce((sum, entry) => sum + entry.installs, 0),
      activated: packages.reduce((sum, entry) => sum + entry.activated, 0),
      firstSuccess: packages.reduce((sum, entry) => sum + entry.firstSuccess, 0),
      d7Retained: packages.reduce((sum, entry) => sum + entry.d7Retained, 0),
      weeklyActiveInstalls: packages.reduce((sum, entry) => sum + entry.weeklyActive, 0),
    },
    packages,
  };
}

function rate(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push('# Telemetry funnel', '');
  const { window: win, totals } = report;
  lines.push(`Window: ${win.from ?? 'n/a'} → ${win.to ?? 'n/a'}`);
  lines.push(`Events: ${totals.events} (CI rows excluded: ${totals.ciExcluded}) · Packages: ${totals.packages}`);
  lines.push(`Install ids: install ${totals.installs} · activated ${totals.activated} · first_success ${totals.firstSuccess} · d7_retained ${totals.d7Retained} · weekly_active ${totals.weeklyActiveInstalls}`);
  lines.push('');
  lines.push('| Package | Installs | Activated | % | First success | % | D7 | % | Weekly active | % | Feedback |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of report.packages) {
    lines.push(`| ${entry.package} | ${entry.installs} | ${entry.activated} | ${fmt(entry.activationRate)} | ${entry.firstSuccess} | ${fmt(entry.successRate)} | ${entry.d7Retained} | ${fmt(entry.d7Rate)} | ${entry.weeklyActive} | ${fmt(entry.weeklyShare)} | ${entry.feedback.positive}/${entry.feedback.neutral}/${entry.feedback.negative} |`);
  }
  if (!report.packages.length) lines.push('| (no events) | | | | | | | | | | |');
  for (const entry of report.packages) {
    lines.push('', `## ${entry.package}`);
    if (entry.weeks.length) {
      lines.push(`Weekly active: ${entry.weeks.map(w => `${w.week} ${w.count}`).join(' · ')}`);
    }
    if (entry.versions.length) {
      lines.push('', '| Version | Installs | Activated | First success | D7 |', '| --- | --- | --- | --- | --- |');
      for (const version of entry.versions) {
        lines.push(`| ${version.version} | ${version.installs} | ${version.activated} | ${version.firstSuccess} | ${version.d7Retained} |`);
      }
    }
  }
  lines.push('', '> Denominators count opt-in install ids only. npm downloads include CI, mirrors and reinstalls, so downloads are not users. A once event is at-most-once, not guaranteed delivery: treat every number as a lower bound.');
  return lines.join('\n');
}

function fmt(value) {
  return value === null ? 'n/a' : `${value}%`;
}

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  const includeCi = args.includes('--include-ci');
  const fileIndex = args.indexOf('--events');
  const path = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
  if (fileIndex >= 0 && !path) throw new Error('--events requires a path');
  const raw = path ? readFileSync(path, 'utf8') : readFileSync(0, 'utf8');
  const report = buildReport(parseEvents(raw), { includeCi });
  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${renderMarkdown(report)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv);
  } catch (error) {
    process.stderr.write(`funnel: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
