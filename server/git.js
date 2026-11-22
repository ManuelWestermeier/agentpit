import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { UserError } from './util.js';

const GITIGNORE = `# Agent Cockpit – Projektvorlage
node_modules/
work/
output/browser/
*.mp4
*.webm
*.mov
*.mkv
*.wav
.env
.env.*
.claude/settings.local.json
.DS_Store
Thumbs.db
`;

function git(cwd, args, { input, maxBuffer = 20 * 1024 * 1024, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, maxBuffer, timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(new UserError('git ist nicht installiert (winget install --id Git.Git -e)'));
        return reject(new UserError(String(stderr || err.message).trim().split('\n').slice(0, 6).join('\n')));
      }
      resolve(String(stdout));
    });
    if (input != null) child.stdin.end(input);
  });
}

const STATUS = { M: 'geändert', A: 'neu', D: 'gelöscht', R: 'umbenannt', C: 'kopiert', U: 'Konflikt', '?': 'neu' };

/** Version control per project folder (plain git, so Claude Code can use it as well). */
export class Git {
  constructor(ctx) { this.ctx = ctx; }

  dir(projectId) { return this.ctx.projects.dirOf(projectId); }

  async isRepo(projectId) {
    return fs.existsSync(path.join(this.dir(projectId), '.git'));
  }

  async init(projectId) {
    const cwd = this.dir(projectId);
    if (!(await this.isRepo(projectId))) {
      await git(cwd, ['init']);
      await git(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']).catch(() => {});
    }
    const gi = path.join(cwd, '.gitignore');
    if (!fs.existsSync(gi)) await fsp.writeFile(gi, GITIGNORE);
    await this.#ensureIdentity(cwd);
    const head = await git(cwd, ['rev-parse', '--verify', 'HEAD']).catch(() => null);
    if (!head) {
      await git(cwd, ['add', '-A']);
      await git(cwd, ['commit', '-m', 'Projekt angelegt (Agent Cockpit)', '--allow-empty']);
    }
    return this.status(projectId);
  }

  /** Commits fail without user.name/email – set a repo-local fallback only when none is configured. */
  async #ensureIdentity(cwd) {
    const name = await git(cwd, ['config', 'user.name']).catch(() => '');
    const email = await git(cwd, ['config', 'user.email']).catch(() => '');
    if (!name.trim()) await git(cwd, ['config', 'user.name', 'Agent Cockpit']);
    if (!email.trim()) await git(cwd, ['config', 'user.email', 'cockpit@localhost']);
  }

  async status(projectId) {
    if (!(await this.isRepo(projectId))) return { repo: false };
    const cwd = this.dir(projectId);
    const [branch, raw, log] = await Promise.all([
      git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'main'),
      git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      this.log(projectId, 40),
    ]);
    const files = [];
    const parts = raw.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (!e) continue;
      const x = e[0], y = e[1], file = e.slice(3);
      if (x === 'R' || x === 'C') i++; // rename: next entry is the source path
      const code = x !== ' ' && x !== '?' ? x : y;
      files.push({ path: file, code, label: STATUS[code] ?? code, staged: x !== ' ' && x !== '?' });
    }
    return { repo: true, branch: branch.trim(), files: files.slice(0, 500), truncated: files.length > 500, log, remote: await this.remote(projectId) };
  }

  async log(projectId, n = 40) {
    const out = await git(this.dir(projectId), ['log', `-n${n}`, '--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%s']).catch(() => '');
    return out.split('\n').filter(Boolean).map((l) => {
      const [hash, short, author, at, subject] = l.split('\x1f');
      return { hash, short, author, at: Number(at) * 1000, subject };
    });
  }

  async diff(projectId, file) {
    const cwd = this.dir(projectId);
    if (file != null) {
      const { rel } = await this.ctx.files.resolve(projectId, file);
      const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', rel]).then(() => true, () => false);
      if (!tracked) {
        const abs = path.join(cwd, rel);
        const st = await fsp.stat(abs).catch(() => null);
        if (!st) return '';
        if (st.size > 400_000) return `(neue Datei, ${Math.round(st.size / 1024)} KB)`;
        const text = await fsp.readFile(abs, 'utf8');
        return text.split('\n').map((l) => `+${l}`).join('\n');
      }
      return (await git(cwd, ['diff', 'HEAD', '--', rel])).slice(0, 400_000);
    }
    return (await git(cwd, ['diff', 'HEAD'])).slice(0, 400_000);
  }

  async show(projectId, hash) {
    if (!/^[0-9a-f]{4,40}$/i.test(String(hash))) throw new UserError('Ungültiger Commit');
    return (await git(this.dir(projectId), ['show', '--stat', '--patch', '--format=%H%n%an <%ae>%n%ad%n%n%B', hash])).slice(0, 400_000);
  }

  async commit(projectId, message, { auto = false } = {}) {
    const cwd = this.dir(projectId);
    if (!(await this.isRepo(projectId))) {
      if (auto) return null;
      await this.init(projectId);
    }
    const msg = String(message ?? '').trim().slice(0, 2000) || 'Änderungen';
    await this.#ensureIdentity(cwd);
    await git(cwd, ['add', '-A']);
    const staged = await git(cwd, ['diff', '--cached', '--name-only']);
    if (!staged.trim()) {
      if (auto) return null;
      throw new UserError('Keine Änderungen zum Committen');
    }
    await git(cwd, ['commit', '-m', msg]);
    const [last] = await this.log(projectId, 1);
    this.ctx.files.touched(projectId);
    return last;
  }

  async discard(projectId, file) {
    const cwd = this.dir(projectId);
    const { rel } = await this.ctx.files.resolve(projectId, file);
    const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', rel]).then(() => true, () => false);
    if (tracked) await git(cwd, ['checkout', 'HEAD', '--', rel]);
    else await fsp.rm(path.join(cwd, rel), { force: true, recursive: true });
    this.ctx.files.touched(projectId);
  }

  async remote(projectId) {
    if (!(await this.isRepo(projectId))) return null;
    const cwd = this.dir(projectId);
    const url = (await git(cwd, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
    if (!url) return null;
    const counts = await git(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD']).catch(() => null);
    const [behind, ahead] = counts ? counts.trim().split(/\s+/).map(Number) : [null, null];
    return { url: url.replace(/\/\/[^@/]+@/, '//'), ahead, behind };
  }

  async push(projectId) {
    const cwd = this.dir(projectId);
    await git(cwd, ['push', '-u', 'origin', 'HEAD'], { timeout: 120_000 });
    return this.remote(projectId);
  }

  async pull(projectId) {
    const cwd = this.dir(projectId);
    await git(cwd, ['fetch', 'origin'], { timeout: 120_000 });
    await git(cwd, ['pull', '--ff-only'], { timeout: 120_000 });
    this.ctx.files.touched(projectId);
    return this.remote(projectId);
  }

  async setRemote(projectId, url) {
    const u = String(url ?? '').trim();
    if (!/^(https:\/\/|git@)[^\s]+$/.test(u)) throw new UserError('Remote-URL im Format https://github.com/user/repo.git');
    const cwd = this.dir(projectId);
    const has = (await git(cwd, ['remote']).catch(() => '')).split('\n').includes('origin');
    await git(cwd, ['remote', has ? 'set-url' : 'add', 'origin', u]);
    return this.remote(projectId);
  }

  async revert(projectId, hash) {
    if (!/^[0-9a-f]{4,40}$/i.test(String(hash))) throw new UserError('Ungültiger Commit');
    const st = await this.status(projectId);
    if (st.files?.length) throw new UserError('Erst offene Änderungen committen oder verwerfen');
    await git(this.dir(projectId), ['revert', '--no-edit', hash]);
    this.ctx.files.touched(projectId);
  }
}

export { GITIGNORE };
