import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Agent, request } from 'node:https';
import type { ClientRequest } from 'node:http';

export type EventName = 'install' | 'activated' | 'first_success' | 'd7_retained' | 'weekly_active' | 'feedback';
export type Feedback = 'positive' | 'neutral' | 'negative';
export interface TelemetryEvent {
  schema_version: 1;
  event: EventName;
  event_id: string;
  anonymous_install_id: string;
  package: string;
  version: string;
  timestamp: string;
  os: string;
  node_major: number;
  ci: boolean;
  feature?: string;
  week?: string;
  feedback?: Feedback;
}
export interface TelemetryOptions {
  /** Static public npm package name; never derive from a user's project. */
  package: string;
  /** Static published numeric release version. */
  version: string;
  /** Explicit user consent, obtained AFTER displaying your privacy notice. Default false. */
  enabled?: boolean;
  /** HTTPS collector. No built-in endpoint and no default data collection. */
  endpoint?: string;
  /** Operator attests that collector/proxy/CDN do not retain IPs or identifying headers. */
  collectorPrivacyAcknowledged?: boolean;
  /** Static public feature slugs. No arbitrary event properties or text. */
  features?: readonly string[];
  /** Local only. Defaults to an OS user config directory, independent of cwd. */
  stateDirectory?: string;
  /** Wall-clock network deadline, clamped to 50–1000 ms. Default 500 ms. */
  timeoutMs?: number;
  /** CI is excluded unless explicitly enabled, even with user consent. */
  allowCI?: boolean;
}
export interface Telemetry {
  install(): Promise<void>;
  activated(feature?: string): Promise<void>;
  /** Call ONLY after a real successful core action; derives first-success, D7 and WAU. */
  success(feature?: string): Promise<void>;
  /** Call during real use (never on a timer or package import). */
  active(feature?: string): Promise<void>;
  feedback(value: Feedback, feature?: string): Promise<void>;
  /** Immediately stop new events and destroy in-flight network requests. */
  disable(): void;
  /** Wait for the current bounded queue; never rejects. Optional for CLI shutdown. */
  flush(): Promise<void>;
}
type State = { schema: 1; id: string; install: boolean; activated: boolean; firstSuccess: number | null; d7: boolean; week: string | null };
const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isCI = () => ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'TF_BUILD', 'JENKINS_URL', 'BUILD_ID'].some(k => !!process.env[k] && !['0', 'false'].includes(process.env[k]!.toLowerCase()));
function supportsNativeProxyAgent(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major >= 25 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}
const optedOut = () => ['DO_NOT_TRACK', 'PI_TELEMETRY_DISABLED'].some(k => !!process.env[k] && !['0', 'false'].includes(process.env[k]!.toLowerCase()));
/** Print exactly what would be sent, send nothing, and leave local state untouched. */
const debugMode = () => !!process.env.PI_TELEMETRY_DEBUG && !['0', 'false'].includes(process.env.PI_TELEMETRY_DEBUG.toLowerCase());
/** UTC Monday date identifies the natural week, including ISO year boundaries. */
function weekOf(time: number): string {
  const d = new Date(time);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}
function validState(s: State): boolean {
  return s?.schema === 1 && UUID.test(s.id) && typeof s.install === 'boolean' && typeof s.activated === 'boolean'
    && typeof s.d7 === 'boolean' && (s.firstSuccess === null || (Number.isFinite(s.firstSuccess) && s.firstSuccess >= 0))
    && (s.week === null || /^\d{4}-\d{2}-\d{2}$/.test(s.week));
}

/** No filesystem or network work happens until an explicitly opted-in event call. */
export function createTelemetry(options: TelemetryOptions): Telemetry {
  let enabled = false;
  let endpoint: URL;
  let directory = '';
  let file = '';
  let timeout = 500;
  let packageName = '';
  let version = '';
  let allowCI = false;
  let features = new Set<string>();
  let agent: Agent | false = false;
  let queue = Promise.resolve();
  let pending = 0;
  const requests = new Set<ClientRequest>();
  try {
    packageName = options.package;
    version = options.version;
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName) || packageName.length > 214) throw Error();
    if (!/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version)) throw Error();
    endpoint = new URL(options.endpoint ?? '');
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error();
    features = new Set(options.features ?? []);
    if (features.size > 64 || [...features].some(f => !/^[a-z][a-z0-9_-]{0,47}$/.test(f))) throw Error();
    const root = process.platform === 'win32' ? (process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')) : (process.env.XDG_CONFIG_HOME || join(homedir(), '.config'));
    directory = options.stateDirectory ?? join(root, 'liushiyumathxjtu-telemetry');
    file = join(directory, createHash('sha256').update(packageName).digest('hex') + '.json');
    timeout = Number.isFinite(options.timeoutMs) ? Math.min(1000, Math.max(50, options.timeoutMs!)) : 500;
    allowCI = options.allowCI === true;
    const hasProxyEnv = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'].some(k => !!process.env[k]);
    if (hasProxyEnv && supportsNativeProxyAgent()) agent = new Agent({ proxyEnv: process.env } as any);
    enabled = options.enabled === true && options.collectorPrivacyAcknowledged === true;
  } catch { /* Invalid configuration disables telemetry, never the host program. */ }
  const allowed = () => enabled && !optedOut() && (allowCI || !isCI());
  function send(event: TelemetryEvent): Promise<void> {
    if (!allowed()) return Promise.resolve();
    return new Promise(resolve => {
      let req: ClientRequest | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (req) { requests.delete(req); req.destroy(); }
        resolve();
      };
      try {
        const body = JSON.stringify(event);
        req = request(endpoint, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, finish);
        requests.add(req);
        req.on('error', finish);
        req.on('close', finish);
        req.on('socket', socket => socket.unref());
        timer = setTimeout(finish, timeout);
        timer.unref();
        req.end(body);
      } catch { finish(); }
    });
  }
  async function record(kind: 'install' | 'activated' | 'success' | 'active' | 'feedback', feature?: string, feedback?: Feedback): Promise<void> {
    if (!allowed() || (feature !== undefined && !features.has(feature))) return;
    if (kind === 'feedback' && !['positive', 'neutral', 'negative'].includes(feedback!)) return;
    const lock = file + '.lock';
    let locked = false;
    let temporary: string | undefined;
    const events: TelemetryEvent[] = [];
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // No lock waiting: another process gets priority; avoid delaying the host.
      await mkdir(lock, { mode: 0o700 });
      locked = true;
      let state: State;
      try {
        state = JSON.parse(await readFile(file, 'utf8'));
        if (!validState(state)) return; // Fail closed; don't silently rotate IDs or reset dedupe.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
        state = { schema: 1, id: randomUUID(), install: false, activated: false, firstSuccess: null, d7: false, week: null };
      }
      if (!allowed()) return;
      const now = Date.now();
      const week = weekOf(now);
      const add = (event: EventName) => {
        const payload: TelemetryEvent = { schema_version: 1, event, event_id: randomUUID(), anonymous_install_id: state.id,
          package: packageName, version, timestamp: new Date(now).toISOString(), os: process.platform, node_major: Number(process.versions.node.split('.')[0]), ci: isCI() };
        if (feature !== undefined) payload.feature = feature;
        if (event === 'weekly_active') payload.week = week;
        if (event === 'feedback') payload.feedback = feedback;
        events.push(payload);
      };
      if (kind === 'install' && !state.install) { state.install = true; add('install'); }
      if (kind === 'activated' && !state.activated) { state.activated = true; add('activated'); }
      if (kind === 'success') {
        if (state.firstSuccess === null) { state.firstSuccess = now; add('first_success'); }
        else if (!state.d7 && now - state.firstSuccess >= 7 * DAY && now - state.firstSuccess < 8 * DAY) { state.d7 = true; add('d7_retained'); }
      }
      if ((kind === 'active' || kind === 'success') && (state.week === null || week > state.week)) { state.week = week; add('weekly_active'); }
      if (kind === 'feedback') add('feedback');
      if (!events.length || !allowed()) return;
      if (debugMode()) {
        // Deliberately before the state write: inspecting what would be sent must not
        // consume a once-event, so the real run later still sends it.
        for (const pending of events) process.stderr.write(`[telemetry:debug] ${JSON.stringify(pending)}\n`);
        return;
      }
      temporary = file + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
      temporary = undefined;
    } catch { return; }
    finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
      if (locked) await rm(lock, { recursive: true, force: true }).catch(() => {});
    }
    // Persist BEFORE sending: at most one attempt, no retries/offline spool.
    await Promise.all(events.map(send));
  }
  function enqueue(kind: Parameters<typeof record>[0], feature?: string, feedback?: Feedback): Promise<void> {
    if (!allowed() || pending >= 32) return Promise.resolve();
    pending++;
    queue = queue.then(() => record(kind, feature, feedback)).catch(() => {}).finally(() => { pending--; });
    return queue;
  }
  return {
    install: () => enqueue('install'), activated: feature => enqueue('activated', feature),
    success: feature => enqueue('success', feature), active: feature => enqueue('active', feature),
    feedback: (value, feature) => enqueue('feedback', feature, value),
    disable: () => { enabled = false; for (const req of requests) req.destroy(); },
    flush: () => queue,
  };
}
