import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { cliCmd } from './config.js';
import { installPlan } from './installer.js';

const require = createRequire(import.meta.url);

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve(err ? null : String(stdout || stderr).trim());
    });
  });
}

/** Path of the Claude Code binary that ships with the Agent SDK (same version the SDK speaks). */
export function bundledClaudeBinary() {
  const file = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const variants = process.platform === 'linux'
    ? [`linux-${process.arch}`, `linux-${process.arch}-musl`]
    : [`${process.platform}-${process.arch}`];
  for (const v of variants) {
    try { return require.resolve(`@anthropic-ai/claude-agent-sdk-${v}/${file}`); } catch { /* next */ }
  }
  return null;
}

export function claudeBinary(config) {
  return config.claudeBin || bundledClaudeBinary() || 'claude';
}

function firstExisting(paths) {
  return paths.find((p) => p && fs.existsSync(p)) ?? null;
}

function detectBrowsers() {
  const env = process.env;
  if (process.platform === 'win32') {
    const pf = env.ProgramFiles, pf86 = env['ProgramFiles(x86)'], local = env.LOCALAPPDATA;
    return {
      chrome: firstExisting([pf, pf86, local].filter(Boolean).map((b) => path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'))),
      msedge: firstExisting([pf86, pf].filter(Boolean).map((b) => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))),
    };
  }
  if (process.platform === 'darwin') {
    return {
      chrome: firstExisting(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']),
      msedge: firstExisting(['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']),
    };
  }
  return {
    chrome: firstExisting(['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']),
    msedge: firstExisting(['/usr/bin/microsoft-edge', '/opt/microsoft/msedge/msedge']),
  };
}

const MAC_APPS = [['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'], ['Chromium.app', 'Contents', 'MacOS', 'Chromium']];

/**
 * Executables inside one chromium-<rev>/ folder. Instead of a fixed list of folder names
 * (chrome-linux64, chrome-linux, chrome-linux-arm64, chrome-mac-arm64 …) every folder of the
 * platform is searched, the one matching this CPU first – new Playwright layouts keep working.
 */
function chromiumCandidates(revDir, platform = process.platform, arch = process.arch) {
  const prefix = { win32: 'chrome-win', linux: 'chrome-linux', darwin: 'chrome-mac' }[platform];
  if (!prefix) return [];
  let subs = [];
  try { subs = fs.readdirSync(revDir).filter((d) => d.startsWith(prefix)); } catch { return []; }
  const armFirst = arch === 'arm64' || arch === 'arm';
  const rank = (d) => (/arm/.test(d) === armFirst ? 0 : 1);
  subs.sort((a, b) => rank(a) - rank(b) || b.length - a.length);
  const rels = platform === 'win32' ? [['chrome.exe']] : platform === 'darwin' ? MAC_APPS : [['chrome']];
  return subs.flatMap((d) => rels.map((r) => path.join(revDir, d, ...r)));
}

const isExecutable = (f) => {
  try { fs.accessSync(f, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; }
};

/** Folders that may hold Playwright browsers: ours first, then Playwright's default cache. */
function browserRoots() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const defaults = process.platform === 'win32' ? [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright')]
    : process.platform === 'darwin' ? [path.join(home, 'Library', 'Caches', 'ms-playwright')] : [path.join(home, '.cache', 'ms-playwright')];
  return [...new Set([process.env.PLAYWRIGHT_BROWSERS_PATH, ...defaults].filter(Boolean))];
}

/** Every path findBrowserExecutable('chromium') checks, in order (shown when nothing is found). */
export function chromiumSearchPaths() {
  const out = [];
  for (const base of browserRoots()) {
    let revs = [];
    try { revs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])); } catch { /* missing */ }
    if (!revs.length) out.push(path.join(base, 'chromium-*'));
    for (const r of revs) {
      const c = chromiumCandidates(path.join(base, r));
      out.push(...(c.length ? c : [path.join(base, r, '(leer)')]));
    }
  }
  if (process.platform === 'linux') out.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  return out;
}

/** Executable for a browser engine: 'chromium' = bundled Playwright build (or a system Chromium), else system Chrome/Edge. */
export function findBrowserExecutable(engine) {
  if (engine === 'chrome' || engine === 'msedge') return detectBrowsers()[engine];
  return chromiumSearchPaths().find(isExecutable) ?? null;
}

export const _test = { chromiumCandidates };

/** Via module resolution – installed as a package, npm may hoist dependencies out of our own node_modules. */
export function playwrightMcpCli() {
  try {
    const cli = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
    return fs.existsSync(cli) ? cli : null;
  } catch { return null; }
}

export async function loadPty() {
  try {
    const mod = await import('node-pty');
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

const hint = (key, text, why, cmd) => ({ key, text, why, cmd, install: !!installPlan(key) });

export async function checkEnvironment({ config, root }) {
  const [ffmpeg, git, gh] = await Promise.all([
    run('ffmpeg', ['-hide_banner', '-version']),
    run('git', ['--version']),
    run('gh', ['--version']),
  ]);
  const browsers = detectBrowsers();
  const bundled = findBrowserExecutable('chromium');
  const channel = config.browserChannel || (browsers.chrome ? 'chrome' : browsers.msedge ? 'msedge' : '');
  const bin = claudeBinary(config);
  const claudeVersion = await run(bin, ['--version'], 15000);
  const pty = await loadPty();
  return {
    platform: process.platform,
    node: process.version,
    claude: { bin, version: claudeVersion?.split(/\s/)[0] ?? null, bundled: bin === bundledClaudeBinary() },
    ffmpeg: ffmpeg ? ffmpeg.split('\n')[0].replace(/^ffmpeg version\s+/, '').split(' ')[0] : null,
    git: git ? git.replace(/^git version\s+/, '') : null,
    browser: { channel, chrome: !!browsers.chrome, msedge: !!browsers.msedge, bundled },
    playwrightMcp: !!playwrightMcpCli(),
    pty: !!pty,
    // short text + one-click install where possible (server/installer.js); cmd only where it has to be typed (sudo)
    hints: [
      !ffmpeg && hint('ffmpeg', 'ffmpeg fehlt', 'für Videos', process.platform === 'darwin' ? 'brew install ffmpeg' : process.platform === 'win32' ? 'winget install --id Gyan.FFmpeg -e' : 'sudo apt install ffmpeg'),
      !git && process.platform === 'win32' && hint('git', 'Git fehlt', 'Claude Code braucht dessen Bash', 'winget install --id Git.Git -e'),
      !gh && hint('gh', 'GitHub CLI fehlt', 'für den GitHub-Login', process.platform === 'darwin' ? 'brew install gh' : process.platform === 'win32' ? 'winget install GitHub.cli' : 'https://cli.github.com'),
      !channel && !bundled && { key: 'browser', text: 'Kein Browser', why: 'für Browser-Identitäten', install: true, cmd: cliCmd('install-browser') },
    ].filter(Boolean),
  };
}
