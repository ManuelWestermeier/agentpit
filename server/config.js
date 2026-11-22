import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Program files (server, web/dist, templates). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * State: .env, data/, projects/, trash/, browsers/. From a git checkout that is the checkout itself (unchanged);
 * installed via npm (npx agentpit, npm i -g) the package folder is replaced on every update – so ~/.agentpit.
 */
export const HOME = process.env.AGENTPIT_HOME
  ? path.resolve(process.env.AGENTPIT_HOME)
  : ROOT.split(path.sep).includes('node_modules') ? path.join(os.homedir(), '.agentpit') : ROOT;
fs.mkdirSync(HOME, { recursive: true });
/** How the user runs an admin command in this installation (shown in hints). */
export const cliCmd = (name) => (HOME === ROOT ? `npm run ${name === 'install-browser' ? 'install:browser' : name}` : `npx agentpit ${name}`);

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  // Existing environment variables win over .env (same as dotenv's default).
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    let v = m[2];
    if (/^"(.*)"$/s.test(v)) v = v.slice(1, -1).replace(/\\n/g, '\n');
    else if (/^'(.*)'$/s.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(HOME, '.env'));

const env = process.env;
// Bundled browsers (Chromium + Playwright's ffmpeg for video recording) live next to the app.
// Set before anything spawns, so Playwright MCP child processes find the same installation.
if (!env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = path.join(HOME, 'browsers');
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on|ja)$/i.test(v));
const int = (v, d, min, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'];
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const host = env.HOST || '127.0.0.1';
const allowNonLoopback = bool(env.ALLOW_NON_LOOPBACK, false);
if (!LOOPBACK.has(host) && !allowNonLoopback) {
  console.error(`[config] HOST=${host} ist nicht loopback. Das Cockpit führt Befehle auf diesem Rechner aus.\n` +
    '         Setze ALLOW_NON_LOOPBACK=true nur, wenn du genau weißt, was du tust.');
  process.exit(1);
}

const defaultMode = PERMISSION_MODES.includes(env.DEFAULT_PERMISSION_MODE) ? env.DEFAULT_PERMISSION_MODE : 'acceptEdits';

export const config = Object.freeze({
  host,
  port: int(env.PORT, 4317, 1, 65535),
  previewPort: int(env.PREVIEW_PORT, 0, 0, 65535), // 0 = port + 1
  openBrowser: bool(env.OPEN_BROWSER, true),
  home: HOME,
  projectsDir: path.resolve(HOME, env.PROJECTS_DIR || 'projects'),
  dataDir: path.resolve(HOME, env.DATA_DIR || 'data'),
  templatesDir: path.join(ROOT, 'templates'),
  trashDir: path.join(HOME, 'trash'),
  webDist: path.join(ROOT, 'web', 'dist'),
  idleTimeoutMin: int(env.IDLE_TIMEOUT_MIN, 20, 0, 24 * 60),
  maxRunners: int(env.MAX_RUNNERS, 6, 1, 32),
  allowBypass: bool(env.ALLOW_BYPASS_PERMISSIONS, false),
  defaultModel: env.DEFAULT_MODEL || '',
  defaultMode: defaultMode === 'bypassPermissions' && !bool(env.ALLOW_BYPASS_PERMISSIONS, false) ? 'acceptEdits' : defaultMode,
  defaultEffort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(env.DEFAULT_EFFORT) ? env.DEFAULT_EFFORT : '',
  usagePollSec: int(env.USAGE_POLL_SEC, 300, 30, 3600),
  claudeBin: env.CLAUDE_BIN || '',
  browserMcp: bool(env.BROWSER_MCP, true),
  browserChannel: env.BROWSER_CHANNEL || '',
  promptSuggestions: bool(env.PROMPT_SUGGESTIONS, false),
  devOrigins: list(env.DEV_ORIGINS),
  // Remote access through a reverse proxy (recommended: `tailscale serve`), e.g. https://jetson.tail1234.ts.net
  publicUrls: list(env.PUBLIC_URL).map((u) => u.replace(/\/+$/, '')),
  previewPublicUrl: (env.PREVIEW_PUBLIC_URL || '').replace(/\/+$/, ''),
  maxBrowsers: int(env.MAX_BROWSERS, 4, 1, 20),
  historyLimit: int(env.HISTORY_LIMIT, 4000, 200, 50_000),
  // summarise the context between answers from this fill level on (0 = only Claude Code's own late auto-compact)
  autoCompactPct: int(env.AUTO_COMPACT_PCT, 75, 0, 100),
  // automatic cleanup (server/janitor.js); ages in days since last change
  cleanup: bool(env.CLEANUP, true),
  trashDays: int(env.TRASH_DAYS, 30, 1, 3650),                     // deleted projects/identities in trash/
  browserArtifactDays: int(env.BROWSER_ARTIFACT_DAYS, 2, 1, 365),  // output/browser: snapshots, logs, traces
  browserMediaDays: int(env.BROWSER_MEDIA_DAYS, 7, 1, 3650),       // output/browser: recordings, screenshots
  workDays: int(env.WORK_DAYS, 14, 1, 3650),                       // work/: intermediate files
  outputDays: int(env.OUTPUT_DAYS, 0, 0, 3650),                    // output/ results: 0 = keep forever
  profileCacheMb: int(env.PROFILE_CACHE_MB, 200, 50, 100_000),     // browser caches per identity above this → emptied
  permissionModes: PERMISSION_MODES,
});
