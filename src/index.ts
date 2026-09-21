import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Agent, request } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

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
  package: string;
  version: string;
  enabled?: boolean;
  endpoint?: string;
  collectorPrivacyAcknowledged?: boolean;
  features?: readonly string[];
  stateDirectory?: string;
  timeoutMs?: number;
  allowCI?: boolean;
}
export interface Telemetry {
  install(): Promise<void>;
  activated(feature?: string): Promise<void>;
  success(feature?: string): Promise<void>;
  active(feature?: string): Promise<void>;
  feedback(value: Feedback, feature?: string): Promise<void>;
  disable(): void;
  flush(): Promise<void>;
}
type State = {
  schema: 1;
  id: string;
  install: boolean;
  activated: boolean;
  firstSuccess: number | null;
  d7: boolean;
  week: string | null;
  pending?: TelemetryEvent[];
};
const DAY = 86_400_000;
const MAX_PENDING = 8;
const PENDING_TTL = 7 * DAY;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/;
const FEATURE = /^[a-z][a-z0-9_-]{0,47}$/;
const EVENT_NAMES = new Set<EventName>(['install', 'activated', 'first_success', 'd7_retained', 'weekly_active', 'feedback']);
const EVENT_KEYS = new Set(['schema_version','event','event_id','anonymous_install_id','package','version','timestamp','os','node_major','ci','feature','week','feedback']);
const isCI = () => ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'TF_BUILD', 'JENKINS_URL', 'BUILD_ID'].some(k => !!process.env[k] && !['0', 'false'].includes(process.env[k]!.toLowerCase()));
function supportsNativeProxyAgent(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major >= 25 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}
const optedOut = () => ['DO_NOT_TRACK', 'PI_TELEMETRY_DISABLED'].some(k => !!process.env[k] && !['0', 'false'].includes(process.env[k]!.toLowerCase()));
const debugMode = () => !!process.env.PI_TELEMETRY_DEBUG && !['0', 'false'].includes(process.env.PI_TELEMETRY_DEBUG.toLowerCase());
function weekOf(time: number): string {
  const d = new Date(time);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}
function validPendingEvent(value: unknown): value is TelemetryEvent {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(k => !EVENT_KEYS.has(k))) return false;
  if (p.schema_version !== 1 || typeof p.event !== 'string' || !EVENT_NAMES.has(p.event as EventName)) return false;
  if (typeof p.event_id !== 'string' || !UUID.test(p.event_id)) return false;
  if (typeof p.anonymous_install_id !== 'string' || !UUID.test(p.anonymous_install_id)) return false;
  if (typeof p.package !== 'string' || p.package.length > 214 || !PACKAGE.test(p.package)) return false;
  if (typeof p.version !== 'string' || !VERSION.test(p.version)) return false;
  if (typeof p.timestamp !== 'string' || !Number.isFinite(Date.parse(p.timestamp))) return false;
  if (typeof p.os !== 'string' || !p.os || p.os.length > 32) return false;
  if (!Number.isInteger(p.node_major) || Number(p.node_major) < 18 || Number(p.node_major) > 99) return false;
  if (typeof p.ci !== 'boolean') return false;
  if (p.feature !== undefined && (typeof p.feature !== 'string' || !FEATURE.test(p.feature))) return false;
  if (p.week !== undefined && (typeof p.week !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.week))) return false;
  if (p.feedback !== undefined && !['positive', 'neutral', 'negative'].includes(String(p.feedback))) return false;
  return true;
}
function validState(s: State): boolean {
  return s?.schema === 1 && UUID.test(s.id) && typeof s.install === 'boolean' && typeof s.activated === 'boolean'
    && typeof s.d7 === 'boolean' && (s.firstSuccess === null || (Number.isFinite(s.firstSuccess) && s.firstSuccess >= 0))
    && (s.week === null || /^\d{4}-\d{2}-\d{2}$/.test(s.week))
    && (s.pending === undefined || (Array.isArray(s.pending) && s.pending.length <= MAX_PENDING && s.pending.every(validPendingEvent)));
}
function prunePending(pending: readonly TelemetryEvent[], now: number): TelemetryEvent[] {
  return pending.filter(event => {
    const timestamp = Date.parse(event.timestamp);
    return Number.isFinite(timestamp) && now - timestamp <= PENDING_TTL;
  });
}

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
  let pendingCalls = 0;
  const requests = new Set<ClientRequest>();
  try {
    packageName = options.package;
    version = options.version;
    if (!PACKAGE.test(packageName) || packageName.length > 214) throw Error();
    if (!VERSION.test(version)) throw Error();
    endpoint = new URL(options.endpoint ?? '');
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error();
    features = new Set(options.features ?? []);
    if (features.size > 64 || [...features].some(f => !FEATURE.test(f))) throw Error();
    const root = process.platform === 'win32' ? (process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')) : (process.env.XDG_CONFIG_HOME || join(homedir(), '.config'));
    directory = options.stateDirectory ?? join(root, 'liushiyumathxjtu-telemetry');
    file = join(directory, createHash('sha256').update(packageName).digest('hex') + '.json');
    timeout = Number.isFinite(options.timeoutMs) ? Math.min(1000, Math.max(50, options.timeoutMs!)) : 500;
    allowCI = options.allowCI === true;
    const hasProxyEnv = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'].some(k => !!process.env[k]);
    if (hasProxyEnv && supportsNativeProxyAgent()) agent = new Agent({ proxyEnv: process.env } as any);
    enabled = options.enabled === true && options.collectorPrivacyAcknowledged === true;
  } catch {}
  const allowed = () => enabled && !optedOut() && (allowCI || !isCI());

  async function saveState(state: State): Promise<void> {
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function readState(): Promise<State | undefined> {
    try {
      const state = JSON.parse(await readFile(file, 'utf8')) as State;
      return validState(state) ? state : undefined;
    } catch {
      return undefined;
    }
  }

  function send(event: TelemetryEvent): Promise<boolean> {
    if (!allowed()) return Promise.resolve(false);
    return new Promise(resolve => {
      let req: ClientRequest | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (req) { requests.delete(req); req.destroy(); }
        resolve(ok);
      };
      try {
        const body = JSON.stringify(event);
        req = request(endpoint, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (response?: IncomingMessage) => {
          const status = Number(response?.statusCode ?? 204);
          response?.resume();
          finish(status >= 200 && status < 300);
        });
        requests.add(req);
        req.on('error', () => finish(false));
        req.on('close', () => finish(false));
        req.on('socket', (socket: Socket) => socket.unref());
        timer = setTimeout(() => finish(false), timeout);
        timer.unref();
        req.end(body);
      } catch { finish(false); }
    });
  }

  async function acknowledge(eventIds: Set<string>): Promise<void> {
    if (!eventIds.size) return;
    const lock = file + '.lock';
    let locked = false;
    try {
      await mkdir(lock, { mode: 0o700 });
      locked = true;
      const state = await readState();
      if (!state) return;
      const current = state.pending ?? [];
      const next = current.filter(event => !eventIds.has(event.event_id));
      if (next.length === current.length) return;
      state.pending = next;
      await saveState(state);
    } catch { return; }
    finally { if (locked) await rm(lock, { recursive: true, force: true }).catch(() => {}); }
  }

  async function deliverPending(): Promise<void> {
    if (!allowed()) return;
    const deliveryLock = file + '.delivery';
    let locked = false;
    try {
      await mkdir(deliveryLock, { mode: 0o700 });
      locked = true;
      const state = await readState();
      if (!state) return;
      const pending = prunePending(state.pending ?? [], Date.now());
      if (!pending.length) return;
      const results = await Promise.all(pending.map(async event => [event.event_id, await send(event)] as const));
      const acknowledged = new Set(results.filter(([, ok]) => ok).map(([id]) => id));
      await acknowledge(acknowledged);
    } catch { return; }
    finally { if (locked) await rm(deliveryLock, { recursive: true, force: true }).catch(() => {}); }
  }

  async function clearPending(): Promise<void> {
    if (!file) return;
    const lock = file + '.lock';
    let locked = false;
    try {
      await mkdir(lock, { mode: 0o700 });
      locked = true;
      const state = await readState();
      if (!state || !(state.pending?.length)) return;
      state.pending = [];
      await saveState(state);
    } catch { return; }
    finally { if (locked) await rm(lock, { recursive: true, force: true }).catch(() => {}); }
  }

  async function record(kind: 'install' | 'activated' | 'success' | 'active' | 'feedback' | 'flush', feature?: string, feedback?: Feedback): Promise<void> {
    if (!allowed() || (feature !== undefined && !features.has(feature))) return;
    if (kind === 'feedback' && !['positive', 'neutral', 'negative'].includes(feedback!)) return;
    const lock = file + '.lock';
    let locked = false;
    let shouldDeliver = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await mkdir(lock, { mode: 0o700 });
      locked = true;
      let state: State;
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as State;
        if (!validState(parsed)) return;
        state = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
        state = { schema: 1, id: randomUUID(), install: false, activated: false, firstSuccess: null, d7: false, week: null, pending: [] };
      }
      if (!allowed()) return;
      const now = Date.now();
      const week = weekOf(now);
      const originalPending = state.pending ?? [];
      state.pending = prunePending(originalPending, now);
      let changed = state.pending.length !== originalPending.length;
      const debugEvents: TelemetryEvent[] = [];
      const add = (event: EventName): boolean => {
        if ((state.pending?.length ?? 0) >= MAX_PENDING) return false;
        const payload: TelemetryEvent = { schema_version: 1, event, event_id: randomUUID(), anonymous_install_id: state.id,
          package: packageName, version, timestamp: new Date(now).toISOString(), os: process.platform, node_major: Number(process.versions.node.split('.')[0]), ci: isCI() };
        if (feature !== undefined) payload.feature = feature;
        if (event === 'weekly_active') payload.week = week;
        if (event === 'feedback') payload.feedback = feedback;
        state.pending!.push(payload);
        debugEvents.push(payload);
        changed = true;
        return true;
      };
      if (kind === 'install' && !state.install && add('install')) state.install = true;
      if (kind === 'activated' && !state.activated && add('activated')) state.activated = true;
      if (kind === 'success') {
        if (state.firstSuccess === null) {
          if (add('first_success')) state.firstSuccess = now;
        } else if (!state.d7 && now - state.firstSuccess >= 7 * DAY && now - state.firstSuccess < 8 * DAY) {
          if (add('d7_retained')) state.d7 = true;
        }
      }
      if ((kind === 'active' || kind === 'success') && (state.week === null || week > state.week)) {
        if (add('weekly_active')) state.week = week;
      }
      if (kind === 'feedback') add('feedback');
      if (debugMode()) {
        for (const pending of debugEvents) process.stderr.write(`[telemetry:debug] ${JSON.stringify(pending)}\n`);
        return;
      }
      if (!allowed()) return;
      if (changed) await saveState(state);
      shouldDeliver = (state.pending?.length ?? 0) > 0;
    } catch { return; }
    finally { if (locked) await rm(lock, { recursive: true, force: true }).catch(() => {}); }
    if (shouldDeliver && allowed()) await deliverPending();
  }

  function enqueue(kind: Parameters<typeof record>[0], feature?: string, feedback?: Feedback): Promise<void> {
    if (!allowed() || pendingCalls >= 32) return Promise.resolve();
    pendingCalls++;
    queue = queue.then(() => record(kind, feature, feedback)).catch(() => {}).finally(() => { pendingCalls--; });
    return queue;
  }

  return {
    install: () => enqueue('install'), activated: feature => enqueue('activated', feature),
    success: feature => enqueue('success', feature), active: feature => enqueue('active', feature),
    feedback: (value, feature) => enqueue('feedback', feature, value),
    disable: () => {
      enabled = false;
      for (const req of requests) req.destroy();
      void queue.finally(() => clearPending());
    },
    flush: () => enqueue('flush'),
  };
}
