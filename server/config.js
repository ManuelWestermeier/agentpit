import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
loadDotEnv(path.join(ROOT, '.env'));

const env = process.env;
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
  projectsDir: path.resolve(ROOT, env.PROJECTS_DIR || 'projects'),
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  templatesDir: path.join(ROOT, 'templates'),
  trashDir: path.join(ROOT, 'trash'),
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
  historyLimit: int(env.HISTORY_LIMIT, 4000, 200, 50_000),
  permissionModes: PERMISSION_MODES,
});
