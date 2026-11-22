import { claudeBinary, loadPty } from './environment.js';
import { TailBuffer, UserError, isUuid, uuid } from './util.js';

/** Optional PTY terminals (node-pty) per project: a shell or the interactive Claude Code TUI. */
export class Terminals {
  constructor(ctx) {
    this.ctx = ctx;
    this.pty = null;
    this.items = new Map();
  }

  async init() {
    this.pty = await loadPty();
    return !!this.pty;
  }

  get available() { return !!this.pty; }

  list(projectId) {
    return [...this.items.values()]
      .filter((t) => t.projectId === projectId)
      .map(({ id, kind, title, alive, exitCode }) => ({ id, kind, title, alive, exitCode }));
  }

  async open({ projectId, kind = 'shell', sessionId = null, cols = 100, rows = 30 }) {
    if (!this.pty) throw new UserError('Terminal nicht verfügbar (node-pty konnte nicht installiert werden).');
    const { projects, runners, config } = this.ctx;
    const cwd = projects.dirOf(projectId);
    let file, args, title;
    if (kind === 'claude') {
      if (runners.peek(projectId)?.live) throw new UserError('Die Session läuft gerade im Cockpit – erst beenden, dann im Terminal öffnen.');
      file = claudeBinary(config);
      args = isUuid(sessionId) ? ['--resume', sessionId] : [];
      title = isUuid(sessionId) ? `claude --resume ${sessionId.slice(0, 8)}` : 'claude';
    } else if (process.platform === 'win32') {
      file = 'powershell.exe';
      args = ['-NoLogo'];
      title = 'PowerShell';
    } else {
      file = process.env.SHELL || '/bin/bash';
      args = [];
      title = file.split('/').pop();
    }
    const id = uuid();
    const proc = this.pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(20, Math.min(400, cols | 0)),
      rows: Math.max(5, Math.min(200, rows | 0)),
      cwd,
      env: { ...process.env, COLORTERM: 'truecolor' },
    });
    const term = { id, projectId, kind, title, proc, alive: true, exitCode: null, buf: new TailBuffer(200_000) };
    this.items.set(id, term);
    proc.onData((data) => {
      term.buf.push(data);
      this.ctx.hub.toProject(projectId, { t: 'term', id, data });
    });
    proc.onExit(({ exitCode }) => {
      term.alive = false;
      term.exitCode = exitCode;
      this.ctx.hub.toProject(projectId, { t: 'term_exit', id, exitCode });
    });
    return { id, title, kind };
  }

  #get(id) {
    const t = this.items.get(id);
    if (!t) throw new UserError('Terminal existiert nicht');
    return t;
  }

  replay(id) { return this.#get(id).buf.toString(); }

  write(id, data) {
    const t = this.#get(id);
    if (t.alive && typeof data === 'string' && data.length <= 64 * 1024) t.proc.write(data);
  }

  resize(id, cols, rows) {
    const t = this.#get(id);
    if (t.alive) t.proc.resize(Math.max(20, Math.min(400, cols | 0)), Math.max(5, Math.min(200, rows | 0)));
  }

  close(id) {
    const t = this.items.get(id);
    if (!t) return;
    if (t.alive) { try { t.proc.kill(); } catch { /* gone */ } }
    this.items.delete(id);
  }

  closeAll() {
    for (const id of [...this.items.keys()]) this.close(id);
  }
}
