# @nyn5255/telemetry

Small, explicitly opt-in telemetry for Pi and Node.js packages. Zero runtime dependencies. Node.js 18+. ESM with generated TypeScript declarations. MIT.

**Off by default. The SDK has no implicit endpoint.** This repository operates a reference collector at `https://telemetry-peach.vercel.app/api/events`; health is available at `/api/health` and aggregate-only funnel counts at `/api/funnel`. Importing, constructing, or calling a disabled client performs no filesystem writes or network requests. No npm install hooks are installed.

## Install and integrate

```sh
npm install @nyn5255/telemetry
```

```js
import { createTelemetry } from '@nyn5255/telemetry';

const telemetry = createTelemetry({
  package: 'pi-debug-mode', // static public package metadata
  version: '0.1.8',
  enabled: preferences.telemetryConsent === true, // no implicit consent
  endpoint: 'https://telemetry-peach.vercel.app/api/events',
  collectorPrivacyAcknowledged: true, // only after operator verification below
  features: ['debug'],
});

// Call after consent AND successful initialization, not in a postinstall hook.
void telemetry.install();
// Call when setup is complete and the feature is enabled.
void telemetry.activated('debug');
// Call ONLY after the actual core task succeeds.
void telemetry.success('debug');
// Optional: count real use that has not yet produced a successful outcome.
void telemetry.active('debug');
// User chooses one of three buttons; never send free-form feedback.
void telemetry.feedback('positive', 'debug');

// Revoke consent: persist false in your app, then stop this instance now.
telemetry.disable();
```

See [examples/pi-package.mjs](examples/pi-package.mjs). The host owns consent UI and persistence. Display the collector address, exact fields, purpose, and data retention policy before asking. Defaults and missing preferences must stay false. Neither an environment variable nor a package installation silently opts anyone in.

`DO_NOT_TRACK=1` or `PI_TELEMETRY_DISABLED=1` overrides consent. `PI_TELEMETRY_DEBUG=1` prints exactly what would be sent on stderr, sends nothing, and leaves local state untouched, so a later real run still delivers the event. Other nonempty values except `0` and `false` also disable. These switches are checked on every call and before transmission. CI is skipped unless `allowCI: true`; the event only includes a boolean, never CI identifiers or URLs.

## Funnel and event definitions

| Event | Explicit trigger | Local deduplication |
| --- | --- | --- |
| `install` | First successful initialization observed after opt-in | Once per package state |
| `activated` | Setup completed and package feature enabled | Once per package state |
| `first_success` | First `success()` after a real core action | Once per package state |
| `d7_retained` | Another `success()` at elapsed time **[7 days, 8 days)** after first success | Once, automatically derived |
| `weekly_active` | `active()` or `success()` during actual use | Once per UTC Monday–Sunday natural week |
| `feedback` | Explicit positive/neutral/negative button selection | Each call, bounded queue |

`success()` derives first-success, WAU and D7; there is no public API to forge `d7_retained` directly. D7 is a 24-hour day-seven window, not any return during days 1–7. No background heartbeat or timer generates activity. Feature is optional but, when supplied, must be in the configured static allowlist. WAU dedupe spans features and package versions. The week value is the UTC Monday date, which stays unambiguous across year boundaries. If the clock moves backward to an earlier week, activity is skipped until it catches up.

Use `install → activated → first_success → d7_retained` as the cohort funnel. Weekly active is a rolling health measure and feedback is a side channel. Compute D7 only for first-success cohorts whose full eight-day observation period has elapsed. Divide D7 by eligible first-success installs, not all downloads. Segment CI out. Do not describe opt-in, best-effort measurements as total users; one person may have several installation states. npm downloads are an external distribution metric, not the funnel denominator. Missing early events are not fabricated or backfilled.

## Wire schema v1

```json
{
  "schema_version": 1,
  "event": "weekly_active",
  "event_id": "29a7f011-aa7e-46f1-b36f-0886c238e5f5",
  "anonymous_install_id": "3a7e2f84-6966-4382-a1ce-a072ace55c39",
  "package": "pi-debug-mode",
  "version": "0.1.8",
  "timestamp": "2026-09-14T09:00:00.000Z",
  "os": "darwin",
  "node_major": 26,
  "ci": false,
  "feature": "debug",
  "week": "2026-09-14"
}
```

Only the fields declared by `TelemetryEvent` are emitted. `week` exists only for WAU; `feedback` only for feedback, with enum `positive | neutral | negative`. Each emitted event gets a random UUID. Each package has its own persistent random installation UUID, shared across versions but not across packages. No hostname, username, device fingerprint, prompt, code, file path, repository, IP, arbitrary properties, free text, exception message, or environment dump is included. The UUID is a pseudonymous identifier; it is not a guarantee of irreversible anonymization.

Package/version/feature values must be **static public product metadata**: never use user input. Runtime validation restricts names and allowlists features, but cannot determine whether a developer has embedded a secret in an otherwise valid slug. Versions accept numeric `x.y.z` and optional `-alpha.N`, `-beta.N`, or `-rc.N` to avoid uploading build hashes/branch names.

## Collector privacy is an operator responsibility

The SDK sends JSON to your explicitly configured HTTPS endpoint, with only content type and content length headers (plus HTTP's required Host). No cookies, custom authentication, query parameters, URL credentials, redirects, IP lookup, response storage, or error logging. TLS certificate verification remains enabled.

**Every direct network collector necessarily sees the source IP at connection time.** The SDK does not read, encode, or collect it, but it cannot guarantee that an external server does not log it. Set `collectorPrivacyAcknowledged: true` only after verifying that the collector, load balancer, CDN, reverse proxy, hosting platform, observability and error tooling do not retain IPs, forwarded IP headers, user agents, request dumps, or derived identity. A privacy relay can hide the client IP from the final collector, but also needs a verified no-retention policy. If that policy cannot be met, leave telemetry disabled.

Accept only schema-v1 fields and enum events; reject unknown fields. Do not enrich events with IP/geolocation/device identity. Deduplicate on `event_id` as an additional safeguard, cap request sizes, and define a short retention/deletion policy for pseudonymous events. This library contains no remote collector or dashboard, and does not claim your existing infrastructure has been audited. The acknowledgement flag is a deployment gate, not an automated audit.

## Reliability and local state

- Calls return `Promise<void>` and absorb internal failures. For interactive paths, use `void telemetry.success()`; there is no synchronous I/O and telemetry is not a prerequisite for the core task.
- Network deadline defaults to 500 ms and is clamped to 50–1000 ms. The deadline covers connection/DNS/TLS/response waiting. Connections are not reused; sockets and timers are unreferenced so they do not keep an exiting CLI alive. No retries and no offline event spool.
- On Node.js 22.21+, 24.5+, and 25+, standard `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` environment settings are inherited through Node's native proxy-aware Agent. Older Node versions keep the existing direct-connection behavior.
- `flush()` optionally awaits the current queue; it cannot guarantee delivery. Normal process exit may drop events. It is not a hard deadline for unusually slow filesystem operations. At most 32 calls queue; excess calls are dropped.
- Private local state defaults to `$XDG_CONFIG_HOME/liushiyumathxjtu-telemetry` or `~/.config/liushiyumathxjtu-telemetry` on Unix, and `%LOCALAPPDATA%/liushiyumathxjtu-telemetry` on Windows. `stateDirectory` overrides it locally and is never sent. Filenames hash only the public package name. State is per OS user and package, not per project.
- State directory/file creation requests modes 0700/0600 on Unix; Windows uses the user's ACLs. Atomic rename and an exclusive directory lock prevent concurrent processes from creating duplicate installation/first-success attempts. Lock contention drops the event immediately.
- Dedupe is persisted **before** transmission: once means at most one attempt, not guaranteed delivery. Network/HTTP errors can undercount. Do not silently retry the same once event after a failed send.
- Corrupt/unreadable state fails closed, preserving identity rather than resetting counts. A process killed while holding the lock may leave a `.json.lock` directory. After confirming no telemetry process is running, remove only that stale lock to resume; no unsafe automatic stale-lock takeover occurs.
- Disabling preserves local dedupe data. To forget local state, stop all package processes and delete the package's hashed JSON file. Re-enabling after deletion creates a new UUID and a new funnel cohort. Remote deletion must be handled by your collector's policy.

## Develop, verify and publish

```sh
npm ci
npm test
npm run verify:pack
npm pack
```

`verify:pack` audits the exact tarball allowlist/size, installs it into an isolated consumer, imports the public export and type-checks its installed declarations. `dist/` is generated by TypeScript and checked in. GitHub CI tests Node 20/22/24 on Linux/macOS/Windows. Tests never send production telemetry.

For first publication, authenticate on the publishing machine to an account authorized for the `@nyn5255` scope, then:

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish --access public
npm view @nyn5255/telemetry@0.1.1 version dist.integrity --registry=https://registry.npmjs.org/
```

Publishing may require npm's interactive two-factor challenge. Never commit `.npmrc` or paste a token into issues/chat. No credential is included in this package.
