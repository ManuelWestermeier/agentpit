import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { UserError, stripAnsi } from './util.js';

function gh(args, { input, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, { timeout, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(new UserError('GitHub CLI (gh) fehlt – https://cli.github.com bzw. winget install --id GitHub.cli'));
        return reject(new UserError(String(stderr || err.message).trim().split('\n').slice(0, 4).join('\n')));
      }
      resolve(String(stdout));
    });
    if (input != null) child.stdin.end(input);
  });
}

/**
 * GitHub login through the official GitHub CLI. Device flow (code + URL) works from any
 * device – the cockpit only relays the code. Afterwards `gh auth setup-git` makes git use it.
 */
export class GitHub extends EventEmitter {
  constructor() {
    super();
    this.status = null;
    this.login = { state: 'idle', code: null, url: null, output: [], error: null };
    this.proc = null;
  }

  async refresh() {
    try {
      const user = JSON.parse(await gh(['api', 'user', '--jq', '{login: .login, name: .name, email: .email}']));
      this.status = { installed: true, loggedIn: true, login: user.login, name: user.name, email: user.email };
    } catch (e) {
      const installed = !/fehlt/.test(e.message);
      this.status = { installed, loggedIn: false, error: installed ? null : e.message };
    }
    this.emit('change');
    return this.status;
  }

  snapshot() { return { status: this.status, login: { ...this.login, output: this.login.output.slice(-20) } }; }

  startDeviceLogin() {
    if (this.proc) return;
    this.login = { state: 'running', code: null, url: 'https://github.com/login/device', output: [], error: null };
    const proc = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key', '--scopes', 'repo,read:org,workflow'], {
      env: { ...process.env, GH_PROMPT_DISABLED: '1', BROWSER: 'false' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    const onData = (d) => {
      const t = stripAnsi(String(d));
      for (const l of t.split(/\r?\n/)) if (l.trim()) this.login.output.push(l.trim());
      const code = t.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
      if (code) this.login.code = code[1];
      const url = t.match(/https:\/\/github\.com\/login\/device\S*/);
      if (url) this.login.url = url[0];
      if (/Press Enter/i.test(t)) proc.stdin.write('\n');
      this.emit('change');
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => { this.login.state = 'error'; this.login.error = e.code === 'ENOENT' ? 'GitHub CLI (gh) ist nicht installiert' : e.message; this.proc = null; this.emit('change'); });
    proc.on('exit', async (code) => {
      this.proc = null;
      if (code === 0) {
        await gh(['auth', 'setup-git']).catch(() => {});
        this.login.state = 'done';
      } else if (this.login.state === 'running') {
        this.login.state = 'error';
        this.login.error = this.login.output.at(-1) ?? `Code ${code}`;
      }
      await this.refresh();
    });
    setTimeout(() => { if (this.proc === proc) { proc.kill(); } }, 15 * 60_000).unref();
    this.emit('change');
  }

  async tokenLogin(token) {
    const t = String(token ?? '').trim();
    if (!/^(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(t)) throw new UserError('Kein gültiges GitHub-Token (ghp_… oder github_pat_…)');
    await gh(['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--with-token'], { input: `${t}\n` });
    await gh(['auth', 'setup-git']).catch(() => {});
    this.login = { state: 'done', code: null, url: null, output: [], error: null };
    return this.refresh();
  }

  cancel() {
    if (this.proc) { this.proc.kill(); this.proc = null; this.login.state = 'idle'; this.emit('change'); }
  }

  async logout() {
    await gh(['auth', 'logout', '--hostname', 'github.com']).catch(() => {});
    return this.refresh();
  }

  /** Creates a GitHub repository from the project folder and pushes it. */
  async publish(cwd, name, isPrivate = true) {
    const repo = String(name ?? '').trim();
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) throw new UserError('Repo-Name: Buchstaben, Ziffern, . _ -');
    await gh(['repo', 'create', repo, isPrivate ? '--private' : '--public', '--source', cwd, '--remote', 'origin', '--push'], { timeout: 120_000 });
  }
}
