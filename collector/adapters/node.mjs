/** Node/Express-style adapter (Vercel Node runtime, Alibaba Cloud FC custom runtime, plain http). */

import { DEFAULT_MAX_BYTES, readBody } from '../handler.mjs';

export function nodeAdapter(handler, maxBytes = DEFAULT_MAX_BYTES) {
  return async function (req, res) {
    const read = await readBody(req, maxBytes);
    const result = read.tooLarge
      ? { status: 413, headers: { 'content-type': 'application/json' }, body: { error: 'payload_too_large' } }
      : await handler({ method: req.method, headers: req.headers, body: read.text });
    res.statusCode = result.status;
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(result.body));
  };
}
