// Shapes of what the cockpit server sends (see server/*.js).

export type RunnerState = 'idle' | 'starting' | 'ready' | 'running' | 'waiting' | 'error';
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'dontAsk' | 'bypassPermissions';

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  mode: PermissionMode;
  effort: string;
  browser: { enabled: boolean; headless: boolean };
  browserProfile: string;
  autoCommit: boolean;
  lastSessionId: string | null;
  dir: string;
  /** set when another session's Claude started this one (sub-session) */
  parentId?: string;
  /** one sentence, written by Claude Haiku from the prompts (server/meta.js) */
  description?: string;
  /** false once the user named the project themselves */
  autoTitle?: boolean;
  /** resources outside the project the user allowed permanently ("db-read:<project>/<conn>", "session:<id>", "browser:<id>") */
  grants?: string[];
  /** summarise the context from this fill level on (%); undefined = server default */
  autoCompactPct?: number;
  /** per-answer limits, 0 = off */
  turnLimits?: { costUsd: number; usagePct: number; minutes: number; calls: number };
}

export interface ModelStats {
  in: number; out: number; cacheRead: number; cacheWrite: number;
  cacheWrite5m: number; cacheWrite1h: number; cost: number;
  canonical?: string; contextWindow?: number;
}

export interface TurnRecord {
  ts: number; cost: number; ms: number; calls: number;
  ctxStart: number; ctxEnd: number; err: boolean; cmd: string | null;
}

export interface SessionStats {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  firstPrompt: string | null;
  forkedFrom: string | null;
  costUsd: number;
  turns: number;
  apiCalls: number;
  outTokens: number;
  models: Record<string, ModelStats>;
  turnLog: TurnRecord[];
  context: {
    tokens: number; max: number; pct: number; threshold: number; window?: number;
    categories?: { id: string; name: string; tokens: number }[];
  };
  cacheTtl: '5m' | '1h' | null;
  lastApiAt: number;
  model: string | null;
}

export interface PermissionRequest {
  id: string;
  toolName: string;
  input: Record<string, any>;
  title: string | null;
  displayName: string | null;
  description: string | null;
  decisionReason: string | null;
  blockedPath: string | null;
  toolUseId: string | null;
  agentId: string | null;
  mcpServer: { name: string; source: string } | null;
  canAlways: boolean;
  defaultToNo: boolean;
  /** cockpit resource access (another project's database/session …), "always" is remembered per project */
  access?: boolean;
  ts: number;
}

export interface BgTask { task_id: string; task_type: string; description: string; subagent_type?: string }

export interface RunnerStatus {
  projectId: string;
  state: RunnerState;
  live: boolean;
  sessionId: string | null;
  model: string | null;
  mode: PermissionMode;
  effort: string;
  version: string | null;
  compacting: boolean;
  error: string | null;
  pending: PermissionRequest[];
  bgTasks: BgTask[];
  mcp: { name: string; status: string }[];
  commands: string[];
  suggestion: string | null;
  lastActivityAt: number;
  turn: { startedAt: number; calls: number; out: number; estCost?: number } | null;
  stats: SessionStats | null;
}

export interface SessionInfo {
  sessionId: string;
  title: string;
  lastModified: number;
  createdAt: number | null;
  hasTranscript: boolean;
  hasLog: boolean;
  costUsd?: number;
  turns?: number;
  forkedFrom?: string | null;
}

export interface ModelInfo {
  value: string;
  resolvedModel: string | null;
  displayName: string;
  description: string;
  supportsEffort: boolean;
  supportedEffortLevels: string[];
  supportsAutoMode: boolean;
}

export interface Catalog {
  models: ModelInfo[];
  prices: Record<string, { in: number; out: number }>;
  commands: { name: string; description: string; argumentHint: string; builtin: boolean }[];
  account: { email?: string; organization?: string; subscriptionType?: string; tokenSource?: string; apiKeySource?: string } | null;
  version: string | null;
  at: number;
}

export interface LimitWindow { u: number; resetsAt: number | null; approx?: boolean }
export interface Forecast { perHour: number; eta: number | null; hitsBeforeReset: boolean; basis: number }

export interface Limits {
  available: boolean | null;
  subscription: string | null;
  windows: Partial<Record<'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet', LimitWindow | null>>;
  modelScoped: { name: string; u: number; resetsAt: number | null }[];
  extra: { is_enabled: boolean; monthly_limit: number | null; used_credits: number | null; utilization: number | null; currency?: string | null } | null;
  at: number;
  warning: { status: string; type: string | null; resetsAt: number | null; utilization: number | null; errorCode: string | null } | null;
  forecast: { five_hour?: Forecast; seven_day?: Forecast; pctPerUsd5h: number | null };
  series: { five_hour: { t: number; u: number }[]; seven_day: { t: number; u: number }[] };
  costTotal: number;
  lastActivity: number;
}

export interface AuthSnapshot {
  status: {
    loggedIn: boolean; authMethod: string; apiProvider?: string; email?: string;
    loginExpiresAt?: string | null; envApiKey?: boolean; envOAuthToken?: boolean; error?: string;
  } | null;
  login: { state: 'idle' | 'running' | 'done' | 'error'; output: string[]; url: string | null; startedAt: number; error: string | null };
}

export interface EnvInfo {
  platform: string;
  node: string;
  claude: { bin: string; version: string | null; bundled: boolean };
  ffmpeg: string | null;
  git: string | null;
  browser: { channel: string; chrome: boolean; msedge: boolean };
  playwrightMcp: boolean;
  pty: boolean;
  hints: { key: string; text: string; why?: string; cmd: string; install?: boolean }[];
}

export type InstallJobs = Record<string, { state: 'running' | 'done' | 'failed'; lines: string[] }>;

export interface Schedule {
  id: string; projectId: string; name: string; prompt: string;
  kind: 'at' | 'every' | 'cron'; at?: number; everyMinutes?: number; cron?: string;
  enabled: boolean; nextRun: number | null; lastRun: number | null; lastError: string | null; runs: number;
  createdBy: string; createdAt: number;
}

export interface Hello {
  schedules?: Schedule[];
  installs?: InstallJobs;
  version: string;
  config: {
    allowBypass: boolean;
    permissionModes: PermissionMode[];
    idleTimeoutMin: number;
    maxRunners: number;
    previewBase: string;
    terminals: boolean;
    remote: boolean;
    hasPassword: boolean;
    autoCompactPct?: number;
  };
  browsers: BrowsersState;
  github: GitHubSnapshot;
  env: EnvInfo;
  auth: AuthSnapshot;
  catalog: Catalog;
  limits: Limits;
  projects: Project[];
  runners: Record<string, RunnerStatus>;
}

export interface FileEntry { name: string; path: string; dir: boolean; size: number | null; mtime: number }

export interface HistoryResult {
  source: 'cockpit' | 'transcript' | 'none';
  events: any[];
  total: number;
  truncated: boolean;
  error?: string;
}

export interface BrowserProfile {
  id: string; name: string; engine: 'chromium' | 'chrome' | 'msedge'; headless: boolean; temporary: boolean;
  proxy: string; lang: string; startUrl: string; color: string; port: number | null;
  languages: string; timezone: string; colorScheme: 'auto' | 'light' | 'dark'; stream: StreamSettings;
  running: boolean; starting: boolean; viewers: number; url: string | null; title: string | null;
}
export interface StreamSettings { mode: 'auto' | 'manual'; quality: number; maxWidth: number; fps: number; format: 'jpeg' | 'png' }
export interface StreamStats {
  mode: 'auto' | 'manual'; level: number; levels: number; quality: number; maxWidth: number; fpsLimit: number; format: string;
  fps: number; kbps: number; skipped: number; frameKb: number;
  /** round trip server → displayed → ack (ms) and the part of it that is queueing; null without acks */
  rtt: number | null; queue: number | null;
}
export interface BrowsersState {
  profiles: BrowserProfile[];
  status: { bundled: boolean; chrome: boolean; msedge: boolean; path: string; install: { state: string; lines: string[] }; defaultHeadless: boolean; virtualDisplay: boolean };
}
export interface GitHubSnapshot {
  status: { installed: boolean; loggedIn: boolean; login?: string; name?: string; email?: string; error?: string | null } | null;
  login: { state: string; code: string | null; url: string | null; output: string[]; error: string | null };
}
export interface ServiceInfo {
  id: string; name: string; command: string; cwd: string; url: string; autostart: boolean; env: Record<string, string>;
  status: 'stopped' | 'starting' | 'running' | 'exited' | 'crashed'; pid: number | null; exitCode: number | null; startedAt: number | null; detectedUrl: string | null;
  port?: number | null; health?: string; restart?: 'no' | 'on-failure' | 'always'; dependsOn?: string[];
  /** last health check while running */
  healthState?: HealthState | null;
  restarts?: number;
  projectId?: string; projectName?: string;
}
export interface HealthState { ok: boolean; code: number | null; ms: number; at: number; url: string }
