import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TailBuffer, UserError, slugify, stripAnsi } from './util.js';

const FILE = 'cockpit.services.json';
const RESTART = ['no', 'on-failure', 'always'];
const HEALTH_EVERY_MS = 10_000;
const MAX_RESTARTS = 5;              // within RESTART_WINDOW_MS, then it stays down
const RESTART_WINDOW_MS = 10 * 60_000;
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
    this.healthTimer = setInterval(() => this.#checkHealth().catch(() => {}), HEALTH_EVERY_MS);
    this.healthTimer.unref?.();
  }

  /** Services of all projects (microservices overview). */
  async listAll() {
    const out = [];
    for (const p of await this.ctx.projects.list()) {
      for (const s of await this.list(p.id)) out.push({ ...s, projectId: p.id, projectName: p.name });
    }
    return out;
  }

  /** URL the health check calls: explicit health URL, or health path on the service URL. */
  #healthUrl(def, state) {
    if (/^https?:\/\//i.test(def.health)) return def.health;
    const base = def.url || state?.url || (def.port ? `http://localhost:${def.port}` : null);
    if (!base) return null;
    return def.health ? new URL(def.health, base.endsWith('/') ? base : `${base}/`).href : base;
  }

  async #checkHealth() {
    const touched = new Set();
    for (const [key, state] of this.procs) {
      if (state.status !== 'running') { if (state.health) { state.health = null; touched.add(key.split('/')[0]); } continue; }
      const [projectId, id] = key.split('/');
      const def = (await this.definitions(projectId)).find((d) => d.id === id);
      const url = def && this.#healthUrl(def, state);
      if (!url) continue;
      const t0 = Date.now();
      let ok = false, code = null;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
        code = r.status;
        ok = r.status < 500;
        r.body?.cancel().catch(() => {});
      } catch { /* down */ }
      const prev = state.health?.ok;
      state.health = { ok, code, ms: Date.now() - t0, at: Date.now(), url };
      if (prev !== ok) touched.add(projectId);
    }
    for (const pid of touched) this.#broadcast(pid);
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
      return {
        ...d, status: p?.status ?? 'stopped', pid: p?.proc?.pid ?? null, exitCode: p?.exitCode ?? null, startedAt: p?.startedAt ?? null,
        detectedUrl: p?.url ?? (d.port ? `http://localhost:${d.port}` : null), healthState: p?.health ?? null, restarts: p?.restarts?.length ?? 0,
      };
    });
  }

  async save(projectId, input) {
    const defs = await this.definitions(projectId);
    const name = String(input.name ?? '').trim().slice(0, 60);
    const command = String(input.command ?? '').trim();
    if (!name || !command) throw new UserError('Name und Befehl sind Pflicht');
    if (command.length > 2000) throw new UserError('Befehl zu lang');
    const id = input.id && defs.some((d) => d.id === input.id) ? input.id : (() => { const b = slugify(name); let id = b; for (let i = 2; defs.some((d) => d.id === id); i++) id = `${b}-${i}`; return id; })();
    const port = input.port === undefined || input.port === '' || input.port === null ? null : Math.round(Number(input.port));
    if (port !== null && !(port >= 1 && port <= 65535)) throw new UserError('Port: 1–65535');
    const def = {
      id, name, command,
      cwd: String(input.cwd ?? '').replace(/\\/g, '/').replace(/^\/+/, '').slice(0, 300),
      url: String(input.url ?? '').trim().slice(0, 300),
      env: input.env && typeof input.env === 'object' ? Object.fromEntries(Object.entries(input.env).filter(([k]) => /^[A-Z_][A-Z0-9_]*$/i.test(k)).map(([k, v]) => [k, String(v)])) : {},
      autostart: input.autostart === true,
      // microservice settings
      port,                                                                           // → PORT env, default URL
      health: String(input.health ?? '').trim().slice(0, 300),                        // path ("/health") or full URL
      restart: RESTART.includes(input.restart) ? input.restart : 'no',                // no | on-failure | always
      dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn.map(String).filter((d) => d !== id).slice(0, 20) : [],
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

  async start(projectId, id, _chain = []) {
    const defs = await this.definitions(projectId);
    const def = defs.find((d) => d.id === id);
    if (!def) throw new UserError(`Dienst „${id}“ existiert nicht`);
    // dependencies first (cycles are ignored)
    for (const dep of def.dependsOn ?? []) {
      if (_chain.includes(dep) || !defs.some((d) => d.id === dep)) continue;
      await this.start(projectId, dep, [..._chain, id]);
    }
    const key = this.#key(projectId, id);
    const cur = this.procs.get(key);
    if (cur?.status === 'running' || cur?.status === 'starting') return;
    const { abs: cwd } = await this.ctx.files.resolve(projectId, def.cwd || '');
    const project = await this.ctx.projects.get(projectId);
    const state = { status: 'starting', log: cur?.log ?? new TailBuffer(200_000), proc: null, exitCode: null, startedAt: Date.now(), url: def.url || null, restarts: cur?.restarts ?? [] };
    this.procs.set(key, state);
    const env = {
      ...process.env,
      ...(def.port ? { PORT: String(def.port) } : {}),
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
      state.health = null;
      this.#append(projectId, id, state, `\n[beendet: ${signal ?? `Code ${code}`}]\n`);
      this.#broadcast(projectId);
      // restart policy: on-failure (crash) / always (also clean exit), with backoff and a cap
      const policy = def.restart ?? 'no';
      if (state.stopping || policy === 'no' || (policy === 'on-failure' && state.status !== 'crashed')) return;
      const now = Date.now();
      state.restarts = state.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
      if (state.restarts.length >= MAX_RESTARTS) {
        this.#append(projectId, id, state, `[kein Neustart: ${MAX_RESTARTS}× in 10 min abgestürzt]\n`);
        return;
      }
      const delay = 1000 * 2 ** state.restarts.length; // 1 s, 2 s, 4 s, 8 s, 16 s
      state.restarts.push(now);
      this.#append(projectId, id, state, `[Neustart in ${delay / 1000} s]\n`);
      setTimeout(() => { if (this.procs.get(key) === state && !state.stopping) this.start(projectId, id).catch(() => {}); }, delay).unref?.();
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
    clearInterval(this.healthTimer);
    await Promise.all([...this.procs.keys()].map((k) => {
      const [p, id] = k.split('/');
      return this.stop(p, id).catch(() => {});
    }));
  }

  async #broadcast(projectId) {
    const services = await this.list(projectId);
    this.ctx.hub.toProject(projectId, { t: 'services', projectId, services });
    // overview of all projects (microservices tab) – everyone may have it open
    this.ctx.hub.toAll({ t: 'services_all', projectId, services });
  }

  exists(projectId) { return fs.existsSync(this.#file(projectId)); }
}
