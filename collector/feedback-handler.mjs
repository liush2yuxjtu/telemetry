import { validateFeedback } from './feedback-schema.mjs';

export const FEEDBACK_MAX_BYTES = 3_600_000;

export function createFeedbackHandler({ store, onError = () => {} }) {
  if (!store || typeof store.insert !== 'function') throw new Error('feedback store required');
  return async function handle(request) {
    const method = String(request?.method ?? '').toUpperCase();
    if (method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    const contentType = header(request, 'content-type');
    if (!contentType?.toLowerCase().startsWith('application/json')) return reply(415, { error: 'unsupported_media_type' });
    const body = typeof request?.body === 'string' ? request.body : '';
    if (Buffer.byteLength(body) > FEEDBACK_MAX_BYTES) return reply(413, { error: 'payload_too_large' });

    let parsed;
    try { parsed = JSON.parse(body); } catch { return reply(400, { error: 'invalid_json' }); }
    const checked = validateFeedback(parsed);
    if (!checked.ok) return reply(400, { error: 'invalid_feedback', detail: checked.error });

    try {
      await store.deleteExpired?.();
      await store.insert(checked.feedback);
    } catch {
      onError({ code: 'feedback_store_unavailable' });
      return reply(500, { error: 'storage_unavailable' });
    }
    return reply(202, { accepted: true, feedback_id: checked.feedback.feedback_id });
  };
}

function header(request, name) {
  const headers = request?.headers;
  if (!headers) return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
function reply(status, body) { return { status, headers: { 'content-type': 'application/json' }, body }; }
