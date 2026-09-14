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
/** No filesystem or network work happens until an explicitly opted-in event call. */
export declare function createTelemetry(options: TelemetryOptions): Telemetry;
