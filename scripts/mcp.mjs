// `agentpit mcp <identity>` – one browser identity as an MCP server for Claude Code / Claude Desktop,
// without the cockpit running. Starts the identity's own profile as a visible window (same port the
// cockpit uses, so a cockpit started later adopts it) and hands stdio to Playwright MCP.
// stdout belongs to the MCP protocol: all messages go to stderr.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';
import { findBrowserExecutable, playwrightMcpCli } from '../server/environment.js';

const argv = process.argv.slice(process.argv.indexOf('mcp') + 1);
const [want, ...extra] = argv;
const fail = (m) => { console.error(`[agentpit] ${m}`); process.exit(1); };

let profiles = [];
try { profiles = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'browsers.json'), 'utf8')).filter((p) => !p.hidden); } catch { /* none yet */ }
const names = () => profiles.map((p) => `  ${p.id}  (${p.name})`).join('\n') || '  – none: create one in the cockpit (Browser) first –';
if (!want) fail(`Usage: agentpit mcp <identity>\nIdentities:\n${names()}`);
const p = profiles.find((x) => x.id === want) ?? profiles.find((x) => x.name?.toLowerCase() === want.toLowerCase());
if (!p) fail(`No browser identity "${want}". Identities:\n${names()}`);
if (!p.port) fail('This identity has no port yet – start the cockpit once.');

const version = async (ms = 600) => {
  try { const r = await fetch(`http://127.0.0.1:${p.port}/json/version`, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; }
};

if (!(await version())) {
  const exe = findBrowserExecutable(p.engine) ?? findBrowserExecutable('chrome') ?? findBrowserExecutable('msedge');
  if (!exe) fail('No browser found – run: npx agentpit install-browser');
  const userDir = path.join(config.dataDir, 'browsers', p.id);
  fs.mkdirSync(userDir, { recursive: true });
  const args = [
    `--user-data-dir=${userDir}`, `--remote-debugging-port=${p.port}`, '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--window-size=1366,860',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  ];
  if (p.proxy) args.push(`--proxy-server=${p.proxy}`);
  if (p.lang) args.push(`--lang=${p.lang}`);
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
  args.push(p.startUrl || 'about:blank');
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.on('error', (e) => fail(e.message));
  child.unref();
  let up = false;
  for (let i = 0; i < 100 && !(up = !!(await version(400))); i++) await new Promise((r) => setTimeout(r, 200));
  if (!up) fail(`"${p.name}" did not start – is the profile open in another window?`);
  console.error(`[agentpit] opened "${p.name}" (port ${p.port})`);
} else {
  console.error(`[agentpit] using running "${p.name}" (port ${p.port})`);
}

const cli = playwrightMcpCli();
if (!cli) fail('@playwright/mcp is missing – reinstall agentpit.');
const mcp = spawn(process.execPath, [cli, '--cdp-endpoint', `http://127.0.0.1:${p.port}`, ...extra], { stdio: 'inherit' });
mcp.on('exit', (code) => process.exit(code ?? 0));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => mcp.kill(s));
