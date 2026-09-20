import { createFeedbackHandler, FEEDBACK_MAX_BYTES } from '../collector/feedback-handler.mjs';
import { createFeedbackSqlStore } from '../collector/feedback-store.mjs';
import { createNeonQuery } from '../collector/neon.mjs';
import { nodeAdapter } from '../collector/adapters/node.mjs';

let store;
try {
  store = createFeedbackSqlStore(createNeonQuery());
} catch {
  store = { async insert() { throw new Error('storage not configured'); }, async deleteExpired() {} };
}

export default nodeAdapter(createFeedbackHandler({ store }), FEEDBACK_MAX_BYTES);
