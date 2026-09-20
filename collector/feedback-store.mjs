export const CREATE_FEEDBACK_TABLE_SQL = `create table if not exists debug_feedback (
  feedback_id uuid primary key,
  schema_version integer not null,
  package text not null,
  version text not null,
  client_timestamp timestamptz not null,
  feedback text not null,
  files jsonb not null,
  redaction jsonb not null,
  received_at timestamptz not null default now()
)`;

export const CREATE_FEEDBACK_INDEX_SQL =
  'create index if not exists debug_feedback_received_at on debug_feedback(received_at)';

const INSERT = `insert into debug_feedback
(feedback_id, schema_version, package, version, client_timestamp, feedback, files, redaction)
values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
on conflict (feedback_id) do nothing`;

const ensured = new WeakSet();

export async function ensureFeedbackSchema(query) {
  if (ensured.has(query)) return;
  await query(CREATE_FEEDBACK_TABLE_SQL, []);
  await query(CREATE_FEEDBACK_INDEX_SQL, []);
  ensured.add(query);
}

export function createFeedbackSqlStore(query) {
  return {
    async insert(item) {
      await ensureFeedbackSchema(query);
      await query(INSERT, [
        item.feedback_id,
        item.schema_version,
        item.package,
        item.version,
        item.client_timestamp,
        item.feedback,
        JSON.stringify(item.files),
        JSON.stringify(item.redaction),
      ]);
    },
    async deleteExpired() {
      await ensureFeedbackSchema(query);
      await query(`delete from debug_feedback where received_at < now() - interval '30 days'`, []);
    },
  };
}
