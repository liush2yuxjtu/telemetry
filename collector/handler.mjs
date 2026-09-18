/**
 * Framework-agnostic funnel collector.
 *
 * The handler is intentionally hostile to metadata: it reads only the method,
 * the content type, and the body length. It never touches the IP address,
 * forwarded headers, the user agent, cookies, or the query string, and it never
 * puts a payload into a log line. What the platform records around the function
 * is outside this code, which is exactly why the SDK requires an explicit
 * `collectorPrivacyAcknowledged` gate before the endpoint is used at all.
 *
 * Contract: POST + JSON, one event per request, always 202 on an accepted or
 * duplicate event (no oracle for "was this install id seen before"), and a
 * generic 500 with no payload echo on storage failure.
 */

import { validateEvent } from './schema.mjs';

export const DEFAULT_MAX_BYTES = 4096;
export const MAX_EVENTS_PER_IP_PER_DAY = null; // per-IP limiting is deliberately not implemented: it needs IPs.

/**
 * @param {{store: {insert: (event: object) => Promise<void>}, maxBytes?: number, onError?: (info: {code: string}) => void}} options
 */
export function createHandler(options) {
  const store = options?.store;
  if (!store || typeof store.insert !== 'function') throw new Error('createHandler requires a store with insert()');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const onError = options.onError ?? (() => {});

  return async function handle(request) {
    const method = String(request?.method ?? '').toUpperCase();
    if (method !== 'POST') return reply(405, { error: 'method_not_allowed' });

    const contentType = header(request, 'content-type');
    if (!contentType || !contentType.toLowerCase().startsWith('application/json')) {
      return reply(415, { error: 'unsupported_media_type' });
    }

    const body = typeof request?.body === 'string' ? request.body : '';
    if (Buffer.byteLength(body, 'utf8') > maxBytes) return reply(413, { error: 'payload_too_large' });

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return reply(400, { error: 'invalid_json' });
    }

    const result = validateEvent(parsed);
    if (!result.ok) return reply(400, { error: 'invalid_event', detail: result.error });

    try {
      await store.insert(result.event);
    } catch {
      onError({ code: 'store_unavailable' });
      return reply(500, { error: 'storage_unavailable' });
    }
    return reply(202, { accepted: true });
  };
}

function header(request, name) {
  const headers = request?.headers;
  if (!headers) return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function reply(status, body) {
  return { status, headers: { 'content-type': 'application/json' }, body };
}

/**
 * Read a request body up to a hard cap, then stop. Returns the text, or
 * `{tooLarge: true}` as soon as the cap is exceeded so a huge body is never
 * buffered in full.
 */
export async function readBody(readable, maxBytes = DEFAULT_MAX_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of readable) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) return { tooLarge: true };
    chunks.push(buffer);
  }
  return { text: Buffer.concat(chunks).toString('utf8') };
}
