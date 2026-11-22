import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { UserError, stripAnsi } from './util.js';

/** lstat, not exists: Windows app execution aliases (winget.exe in WindowsApps) fail stat with EACCES. */
const present = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };

function onPath(bin) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) { if (dir && present(path.join(dir, bin + ext))) return true; }
  }
  return false;
}

/** How to install a missing tool on this machine without admin rights – or null (then only a command is shown). */
export function installPlan(key) {
  const win = process.platform === 'win32', mac = process.platform === 'darwin';
  const winget = (id) => (win && onPath('winget') ? { cmd: 'winget', args: ['install', '--id', id, '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'] } : null);
  const brew = (pkg) => (mac && onPath('brew') ? { cmd: 'brew', args: ['install', pkg] } : null);
  switch (key) {
    case 'ffmpeg': return winget('Gyan.FFmpeg') ?? brew('ffmpeg');
    case 'git': return winget('Git.Git');
    case 'gh': return winget('GitHub.cli') ?? brew('gh');
    default: return null;
  }
}

/** Windows: installers write PATH to the registry – read it so this process finds the new tool without a restart. */
function refreshPath() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve();
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
    { windowsHide: true, timeout: 15000 }, (err, out) => {
      if (!err && out.trim()) process.env.PATH = [...new Set([...out.trim().split(';'), ...(process.env.PATH ?? '').split(';')].filter(Boolean))].join(';');
      resolve();
    });
  });
}

/**
 * One-click installs of missing helpers (ffmpeg, git, gh, browser) from the UI – user-scope package
 * managers only (winget / Homebrew), never sudo. Progress and result go to all clients.
 */
export class Installer extends EventEmitter {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.jobs = {}; // key → { state: running|done|failed, lines }
  }

  snapshot() { return this.jobs; }

  /** Validates, then installs in the background (progress via 'change'). */
  start(key) {
    if (key !== 'browser' && !installPlan(key)) throw new UserError('Auf diesem System nicht automatisch installierbar – Befehl im Hinweis verwenden');
    this.install(key).catch((e) => {
      this.jobs[key] = { state: 'failed', lines: [...(this.jobs[key]?.lines ?? []), e.message] };
      this.emit('change');
    });
  }

  async install(key) {
    if (this.jobs[key]?.state === 'running') return;
    if (key === 'browser') { this.ctx.browsers.installBrowsers(); return; }
    const plan = installPlan(key);
    if (!plan) throw new UserError('Auf diesem System nicht automatisch installierbar – Befehl im Hinweis verwenden');
    const job = (this.jobs[key] = { state: 'running', lines: [`${plan.cmd} ${plan.args.join(' ')}`] });
    this.emit('change');
    const code = await new Promise((resolve) => {
      const p = spawn(plan.cmd, plan.args, { windowsHide: true, shell: false });
      const push = (d) => {
        for (const l of stripAnsi(String(d)).split(/[\r\n]+/)) if (l.trim() && !/^[\s\-\\|/█▒]+$/.test(l)) job.lines.push(l.trim().slice(0, 200));
        if (job.lines.length > 40) job.lines.splice(0, job.lines.length - 40);
        this.emit('change');
      };
      p.stdout.on('data', push);
      p.stderr.on('data', push);
      p.on('error', (e) => { job.lines.push(e.message); resolve(-1); });
      p.on('exit', resolve);
    });
    await refreshPath();
    this.ctx.env = await this.ctx.checkEnv();
    const stillMissing = this.ctx.env.hints.some((h) => h.key === key) || (key === 'gh' && !onPath('gh'));
    job.state = code === 0 && !stillMissing ? 'done' : 'failed';
    if (job.state === 'failed') job.lines.push(code === 0 ? 'Installiert, aber noch nicht gefunden – Cockpit neu starten.' : `Beendet mit Code ${code}`);
    if (key === 'gh') this.ctx.github?.refresh?.();
    this.emit('change');
  }
}
