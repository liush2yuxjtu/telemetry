import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFeedback } from '../collector/feedback-schema.mjs';
import { createFeedbackHandler } from '../collector/feedback-handler.mjs';

function payload(extra={}) {
  return {
    schema_version:1,
    feedback_id:'123e4567-e89b-42d3-a456-426614174000',
    package:'pi-debug-mode',
    version:'0.1.12',
    client_timestamp:'2026-09-20T08:00:00.000Z',
    feedback:'Useful, but child output was too long.',
    files:[],
    redaction:{scanner:'trufflehog',scanner_version:'3.90.8',secret_replacements:2,images_removed:0,paths_redacted:3,emails_redacted:1},
    ...extra,
  };
}

test('feedback schema accepts the bounded explicit shape', () => {
  assert.equal(validateFeedback(payload()).ok, true);
});
test('feedback schema rejects unknown fields and missing scanner proof', () => {
  assert.equal(validateFeedback(payload({surprise:'x'})).ok, false);
  assert.equal(validateFeedback(payload({redaction:{scanner:'builtin'}})).ok, false);
  assert.equal(validateFeedback(payload({files:[],redaction:{scanner:'local-redaction',scanner_version:'1',secret_replacements:0,images_removed:0,paths_redacted:0,emails_redacted:0}})).ok, true);
});
test('feedback handler accepts without echoing transcript', async () => {
  const rows=[];
  const h=createFeedbackHandler({store:{deleteExpired:async()=>{},insert:async x=>rows.push(x)}});
  const r=await h({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload())});
  assert.equal(r.status,202);
  assert.deepEqual(Object.keys(r.body).sort(),['accepted','feedback_id']);
  assert.equal(rows.length,1);
});
test('feedback handler rejects non-json requests', async () => {
  const h=createFeedbackHandler({store:{insert:async()=>{}}});
  assert.equal((await h({method:'GET',headers:{},body:''})).status,405);
  assert.equal((await h({method:'POST',headers:{'content-type':'text/plain'},body:'x'})).status,415);
});

test('feedback store creates its isolated schema before first insert', async () => {
  const { createFeedbackSqlStore } = await import('../collector/feedback-store.mjs');
  const calls=[];
  const query=async (sql, params) => { calls.push({sql,params}); return []; };
  const store=createFeedbackSqlStore(query);
  await store.insert(payload());
  assert.match(calls[0].sql, /create table if not exists debug_feedback/);
  assert.match(calls[1].sql, /create index if not exists debug_feedback_received_at/);
  assert.match(calls[2].sql, /insert into debug_feedback/);
});
