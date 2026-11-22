import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TailBuffer, UserError, slugify, stripAnsi } from './util.js';

const FILE = 'cockpit.services.json';
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s"'<>]*/i;

/**
 * Long-running processes per project (dev servers, workers, test UIs).
 * Definitions live in <project>/cockpit.services.json – versioned with git and editable by Claude.
 * Each service gets COCKPIT_HOOK_URL/COCKPIT_HOOK_TOKEN so it can send prompts back into the session.
 */
export class Services {
  constructor(ctx) {
    this.ctx = ctx;
    this.procs = new Map(); // `${projectId}/${id}` → state
  }

  #file(projectId) { return path.join(this.ctx.projects.dirOf(projectId), FILE); }
  #key(projectId, id) { return `${projectId}/${id}`; }

  async definitions(projectId) {
    try {
      const data = JSON.parse(await fsp.readFile(this.#file(projectId), 'utf8'));
      return (Array.isArray(data.services) ? data.services : []).filter((s) => s && typeof s.id === 'string' && typeof s.command === 'string');
    } catch { return []; }
  }

  async list(projectId) {
    const defs = await this.definitions(projectId);
    return defs.map((d) => {
      const p = this.procs.get(this.#key(projectId, d.id));
      return { ...d, status: p?.status ?? 'stopped', pid: p?.proc?.pid ?? null, exitCode: p?.exitCode ?? null, startedAt: p?.startedAt ?? null, detectedUrl: p?.url ?? null };
    });
  }

  async save(projectId, input) {
    const defs = await this.definitions(projectId);
    const name = String(input.name ?? '').trim().slice(0, 60);
    const command = String(input.command ?? '').trim();
    if (!name || !command) throw new UserError('Name und Befehl sind Pflicht');
    if (command.length > 2000) throw new UserError('Befehl zu lang');
    const id = input.id && defs.some((d) => d.id === input.id) ? input.id : (() => { const b = slugify(name); let id = b; for (let i = 2; defs.some((d) => d.id === id); i++) id = `${b}-${i}`; return id; })();
    const def = {
      id, name, command,
      cwd: String(input.cwd ?? '').replace(/\\/g, '/').replace(/^\/+/, '').slice(0, 300),
      url: String(input.url ?? '').trim().slice(0, 300),
      env: input.env && typeof input.env === 'object' ? Object.fromEntries(Object.entries(input.env).filter(([k]) => /^[A-Z_][A-Z0-9_]*$/i.test(k)).map(([k, v]) => [k, String(v)])) : {},
      autostart: input.autostart === true,
    };
    if (def.cwd) await this.ctx.files.resolve(projectId, def.cwd);
    const next = defs.some((d) => d.id === id) ? defs.map((d) => (d.id === id ? def : d)) : [...defs, def];
    await fsp.writeFile(this.#file(projectId), `${JSON.stringify({ services: next }, null, 2)}\n`);
    this.#broadcast(projectId);
    return def;
  }

  async remove(projectId, id) {
    await this.stop(projectId, id);
    const defs = await this.definitions(projectId);
    await fsp.writeFile(this.#file(projectId), `${JSON.stringify({ services: defs.filter((d) => d.id !== id) }, null, 2)}\n`);
    this.#broadcast(projectId);
  }

  async start(projectId, id) {
    const def = (await this.definitions(projectId)).find((d) => d.id === id);
    if (!def) throw new UserError(`Dienst „${id}“ existiert nicht`);
    const key = this.#key(projectId, id);
    const cur = this.procs.get(key);
    if (cur?.status === 'running' || cur?.status === 'starting') return;
    const { abs: cwd } = await this.ctx.files.resolve(projectId, def.cwd || '');
    const project = await this.ctx.projects.get(projectId);
    const state = { status: 'starting', log: cur?.log ?? new TailBuffer(200_000), proc: null, exitCode: null, startedAt: Date.now(), url: def.url || null };
    this.procs.set(key, state);
    const env = {
      ...process.env,
      ...def.env,
      FORCE_COLOR: '0',
      COCKPIT_PROJECT: projectId,
      COCKPIT_HOOK_URL: `${this.ctx.localUrl}/api/hook/${projectId}`,
      COCKPIT_HOOK_TOKEN: project.hookToken ?? '',
    };
    const proc = spawn(def.command, { cwd, env, shell: true, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    state.proc = proc;
    this.#append(projectId, id, state, `$ ${def.command}\n`);
    const onData = (d) => {
      const text = stripAnsi(String(d));
      this.#append(projectId, id, state, text);
      if (!state.url) {
        const m = text.match(URL_RE);
        if (m) { state.url = m[0].replace('0.0.0.0', 'localhost').replace(/[).,;]+$/, ''); this.#broadcast(projectId); }
      }
      if (state.status === 'starting') { state.status = 'running'; this.#broadcast(projectId); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('spawn', () => { setTimeout(() => { if (state.status === 'starting') { state.status = 'running'; this.#broadcast(projectId); } }, 1500); });
    proc.on('error', (e) => { this.#append(projectId, id, state, `\n[Fehler] ${e.message}\n`); });
    proc.on('exit', (code, signal) => {
      state.exitCode = code;
      state.status = state.stopping ? 'stopped' : code === 0 ? 'exited' : 'crashed';
      state.proc = null;
      this.#append(projectId, id, state, `\n[beendet: ${signal ?? `Code ${code}`}]\n`);
      this.#broadcast(projectId);
    });
    this.#broadcast(projectId);
  }

  #append(projectId, id, state, text) {
    state.log.push(text);
    this.ctx.hub.toProject(projectId, { t: 'svclog', projectId, id, text });
  }

  async stop(projectId, id) {
    const state = this.procs.get(this.#key(projectId, id));
    if (!state?.proc) return;
    state.stopping = true;
    const pid = state.proc.pid;
    await new Promise((resolve) => {
      const done = () => resolve();
      state.proc.once('exit', done);
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      else { try { process.kill(-pid, 'SIGTERM'); } catch { try { state.proc.kill('SIGTERM'); } catch { /* gone */ } } }
      setTimeout(() => {
        if (state.proc) { try { process.platform === 'win32' ? state.proc.kill() : process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
        resolve();
      }, 5000);
    });
  }

  async restart(projectId, id) {
    await this.stop(projectId, id);
    await this.start(projectId, id);
  }

  logs(projectId, id, lines = 200) {
    const s = this.procs.get(this.#key(projectId, id));
    if (!s) return '';
    return s.log.toString().split('\n').slice(-lines).join('\n');
  }

  async autostart(projectId) {
    for (const d of await this.definitions(projectId)) if (d.autostart) await this.start(projectId, d.id).catch(() => {});
  }

  async stopAll() {
    await Promise.all([...this.procs.keys()].map((k) => {
      const [p, id] = k.split('/');
      return this.stop(p, id).catch(() => {});
    }));
  }

  async #broadcast(projectId) {
    this.ctx.hub.toProject(projectId, { t: 'services', projectId, services: await this.list(projectId) });
  }

  exists(projectId) { return fs.existsSync(this.#file(projectId)); }
}
