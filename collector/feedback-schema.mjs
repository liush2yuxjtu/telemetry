const MAX_TEXT = 8000;
const MAX_FILES = 9;
const MAX_NAME = 180;
const MAX_B64 = 2_800_000;

export function validateFeedback(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('object_required');
  const allowed = new Set(['schema_version','feedback_id','package','version','client_timestamp','feedback','files','redaction']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) return bad('unknown_field');

  if (input.schema_version !== 1) return bad('schema_version');
  if (!uuid(input.feedback_id)) return bad('feedback_id');
  if (input.package !== 'pi-debug-mode') return bad('package');
  if (!short(input.version, 40)) return bad('version');
  if (!iso(input.client_timestamp)) return bad('client_timestamp');
  if (!short(input.feedback, MAX_TEXT)) return bad('feedback');

  const files = input.files ?? [];
  if (!Array.isArray(files) || files.length > MAX_FILES) return bad('files');
  const normalizedFiles = [];
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return bad('file');
    const keys = new Set(['name','sha256','content_gzip_base64','original_bytes','gzip_bytes']);
    for (const key of Object.keys(file)) if (!keys.has(key)) return bad('file_unknown_field');
    if (!short(file.name, MAX_NAME) || !/^[A-Za-z0-9._-]+\.jsonl\.gz$/.test(file.name)) return bad('file_name');
    if (typeof file.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(file.sha256)) return bad('file_hash');
    if (typeof file.content_gzip_base64 !== 'string' || file.content_gzip_base64.length > MAX_B64 || !/^[A-Za-z0-9+/=]*$/.test(file.content_gzip_base64)) return bad('file_content');
    if (!integer(file.original_bytes, 0, 8_000_000) || !integer(file.gzip_bytes, 0, 2_000_000)) return bad('file_size');
    normalizedFiles.push({
      name: file.name,
      sha256: file.sha256,
      content_gzip_base64: file.content_gzip_base64,
      original_bytes: file.original_bytes,
      gzip_bytes: file.gzip_bytes,
    });
  }

  const redaction = input.redaction;
  if (!redaction || typeof redaction !== 'object' || Array.isArray(redaction)) return bad('redaction');
  const redactionAllowed = new Set(['scanner','scanner_version','secret_replacements','images_removed','paths_redacted','emails_redacted']);
  for (const key of Object.keys(redaction)) if (!redactionAllowed.has(key)) return bad('redaction_unknown_field');
  if (files.length > 0 && redaction.scanner !== 'trufflehog') return bad('scanner');
  if (files.length === 0 && !['trufflehog','local-redaction'].includes(redaction.scanner)) return bad('scanner');
  if (!short(redaction.scanner_version, 100)) return bad('scanner_version');
  for (const key of ['secret_replacements','images_removed','paths_redacted','emails_redacted']) {
    if (!integer(redaction[key], 0, 1_000_000)) return bad('redaction_count');
  }

  return {
    ok: true,
    feedback: {
      schema_version: 1,
      feedback_id: input.feedback_id,
      package: input.package,
      version: input.version,
      client_timestamp: input.client_timestamp,
      feedback: input.feedback,
      files: normalizedFiles,
      redaction: {
        scanner: redaction.scanner,
        scanner_version: redaction.scanner_version,
        secret_replacements: redaction.secret_replacements,
        images_removed: redaction.images_removed,
        paths_redacted: redaction.paths_redacted,
        emails_redacted: redaction.emails_redacted,
      },
    },
  };
}

function short(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function iso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function integer(value, min, max) { return Number.isInteger(value) && value >= min && value <= max; }
function bad(error) { return { ok: false, error }; }
