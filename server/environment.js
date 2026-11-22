import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

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

export function playwrightMcpCli(root) {
  const cli = path.join(root, 'node_modules', '@playwright', 'mcp', 'cli.js');
  return fs.existsSync(cli) ? cli : null;
}

export async function loadPty() {
  try {
    const mod = await import('node-pty');
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

export async function checkEnvironment({ config, root }) {
  const [ffmpeg, git] = await Promise.all([
    run('ffmpeg', ['-hide_banner', '-version']),
    run('git', ['--version']),
  ]);
  const browsers = detectBrowsers();
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
    browser: { channel, chrome: !!browsers.chrome, msedge: !!browsers.msedge },
    playwrightMcp: !!playwrightMcpCli(root),
    pty: !!pty,
    hints: [
      !ffmpeg && (process.platform === 'win32'
        ? { key: 'ffmpeg', text: 'ffmpeg fehlt – für Videos nötig.', cmd: 'winget install --id Gyan.FFmpeg -e' }
        : { key: 'ffmpeg', text: 'ffmpeg fehlt – für Videos nötig.', cmd: process.platform === 'darwin' ? 'brew install ffmpeg' : 'sudo apt install ffmpeg' }),
      !git && process.platform === 'win32' && { key: 'git', text: 'Git for Windows fehlt – Claude Code nutzt dessen Bash.', cmd: 'winget install --id Git.Git -e' },
      !channel && { key: 'browser', text: 'Kein Chrome/Edge gefunden – Browser-Steuerung braucht einen Chromium-Browser.', cmd: 'npx playwright install chromium' },
    ].filter(Boolean),
  };
}
