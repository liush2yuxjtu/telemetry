/**
 * Vercel entry point for the funnel collector.
 *
 * Deploy target: a Vercel project whose root is this repository. `api/events.mjs`
 * becomes a Node function; the collector modules are plain ESM and need no build
 * step.
 *
 * Fail-closed behaviour: with no DATABASE_URL the store throws, the handler
 * answers a generic 500, and nothing is accepted. The endpoint never buffers
 * events in memory hoping for a database later.
 */

import { createHandler } from '../collector/handler.mjs';
import { createSqlStore } from '../collector/store.mjs';
import { createNeonQuery } from '../collector/neon.mjs';
import { nodeAdapter } from '../collector/adapters/node.mjs';

let store;
try {
  store = createSqlStore(createNeonQuery());
} catch {
  store = {
    async insert() {
      throw new Error('storage not configured');
    },
  };
}

export default nodeAdapter(createHandler({ store }));
