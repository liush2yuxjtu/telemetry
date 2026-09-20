# Funnel collector

Receives schema-v1 events from `@nyn5255/telemetry`, stores them as pseudonymous
rows, and feeds the funnel report in `scripts/funnel.mjs`.

Status: **deployed to production at `https://telemetry-peach.vercel.app`.** Events are accepted at `/api/events`, database health is exposed at `/api/health`, and `/api/funnel` returns aggregate-only package/version counts with no event IDs or anonymous install IDs. Nothing in this directory is published to npm: the package `files` list ships only `dist`, `README.md`, `LICENSE`, and `examples`.

## What the funnel measures

| Step | Event | Client trigger |
| --- | --- | --- |
| Install | `install` | First successful initialization after opt-in |
| Activation | `activated` | Setup finished and the feature was switched on |
| First value | `first_success` | First real successful task |
| Day-7 retention | `d7_retained` | Another success 7–8 days after the first |
| Engagement | `weekly_active` | One active/success call per UTC week |
| Sentiment | `feedback` | One of three buttons, never free text |

The client dedupes each once-event locally before sending, and the collector
dedupes again on `event_id`, so a retried request cannot double-count.

## Privacy boundary

Enforced in code, not only in prose:

- `collector/schema.mjs` allow-lists every field. Unknown keys are rejected, so a
  client cannot smuggle an IP, user agent, hostname, path, or prompt into storage.
- `collector/handler.mjs` reads only method, content type, and body length. It never
  reads the IP, forwarded headers, user agent, cookies, or query string, and it
  never puts a payload into a log line.
- `collector/schema.sql` has no column for connection metadata. There is nothing to
  leak later because nothing is stored.
- Storage failure returns a generic `storage_unavailable` with no payload echo.
- Duplicates and fresh rows both return `202`, so the endpoint is not an oracle for
  "has this install id been seen before".

The one thing the SDK cannot control: **every network collector sees the source IP
at connection time.** The platform (function host, log retention, CDN) decides
whether that IP is retained. This is why the SDK requires
`collectorPrivacyAcknowledged: true` and why that flag must stay unset until the
deployment below is verified.

### Before any package may send anything

1. Pick a host and read its logging defaults (does it retain request IPs, forwarded
   headers, user agents, or request bodies?).
2. Turn off request logging, or document exactly what is retained and for how long.
3. Record the retention window and the deletion job (see `auto_retention` below).
4. Only then set `collectorPrivacyAcknowledged: true` in a package, and state the
   collector address, exact fields, and retention policy in that package's consent
   UI before the user opts in.
5. Defaults stay `false`. `DO_NOT_TRACK=1` and `PI_TELEMETRY_DISABLED=1` override
   consent at every call.

## Deployment options

The handler is framework-agnostic; the store is injected. Nothing here locks the
choice in.

| Host | Adapter | Store | Note |
| --- | --- | --- | --- |
| Vercel Functions | `adapters/node.mjs` | Neon/Postgres via `createSqlStore` | CLI already authenticated as `nyn5255-8475`; check log retention |
| Cloudflare Workers | `adapters/web.mjs` | D1 or Hyperdrive | `wrangler` is not authenticated yet |
| Alibaba Cloud FC | `adapters/node.mjs` | RDS Postgres or TableStore | CLI profile `myaliyun` is valid (cn-shanghai) |

Minimal Vercel shape, once a database exists:

```js
// api/events.js
import { createHandler } from '../collector/handler.mjs';
import { createSqlStore } from '../collector/store.mjs';
import { nodeAdapter } from '../collector/adapters/node.mjs';

const query = async (text, params) => (await sql(text, params)); // Neon serverless or pg
export default nodeAdapter(createHandler({ store: createSqlStore(query) }));
```

Apply `collector/schema.sql` to the database before the first request.

## Daily jobs

| Cron (UTC) | Endpoint | Job |
| --- | --- | --- |
| `0 1 * * *` | `/api/digest` | Aggregate the last 30 days, push the digest to `DIGEST_WEBHOOK_URL`; `?dry=1` verifies without messaging |
| `0 2 * * *` | `/api/retention` | Delete pseudonymous rows older than 180 days; `?dry=1` counts first |

Both honor `CRON_SECRET` when it is set, which Vercel Cron sends automatically.
Neither logs a payload or a connection string.

## Running the funnel report

```sh
psql "$DATABASE_URL" -At -f collector/export.sql > events.json
node scripts/funnel.mjs --events events.json          # markdown
node scripts/funnel.mjs --events events.json --json   # machine-readable
node scripts/funnel.mjs --events events.json --include-ci
```

The report excludes CI rows by default and always states its boundaries: counts
are opt-in install ids only, npm downloads are not users, and a once-event is
at-most-once rather than guaranteed delivery, so every number is a lower bound.

## Tests

```sh
node --test test/collector.test.mjs
```

Covers field allow-listing, metadata-smuggling rejection, HTTP status matrix,
`event_id` dedupe, parameterized SQL, body cap, both adapters, funnel math, and a
contract test that feeds the real payload of the shipped SDK into the collector.

## Open decisions

- Collector host and store: Vercel Functions + Neon, live (see table above).
- Retention window: 180 days, enforced daily by `api/retention.mjs`
  (`0 2 * * *`). `GET /api/retention?dry=1` counts what would be deleted without
  deleting it.
- Public consent copy per package, and which packages go first.
- Whether the collector code stays in this public repository (auditable) or moves
  to a private one (deployment details stay private).
