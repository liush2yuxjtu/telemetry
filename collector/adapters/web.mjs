/** Web Fetch adapter (Cloudflare Workers, Vercel Edge, Deno, Bun). */

import { DEFAULT_MAX_BYTES } from '../handler.mjs';

export function webAdapter(handler, maxBytes = DEFAULT_MAX_BYTES) {
  return async function (request) {
    const declared = Number(request.headers.get('content-length') ?? '0');
    let result;
    if (Number.isFinite(declared) && declared > maxBytes) {
      result = { status: 413, headers: {}, body: { error: 'payload_too_large' } };
    } else {
      const text = await request.text();
      if (new TextEncoder().encode(text).length > maxBytes) {
        result = { status: 413, headers: {}, body: { error: 'payload_too_large' } };
      } else {
        const headers = {};
        request.headers.forEach((value, name) => { headers[name] = value; });
        result = await handler({ method: request.method, headers, body: text });
      }
    }
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  };
}
