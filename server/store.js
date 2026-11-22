import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { isUuid } from './util.js';

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const isProjectId = (s) => typeof s === 'string' && PROJECT_ID_RE.test(s);

function assertIds(projectId, sessionId) {
  if (!isProjectId(projectId)) throw new Error(`Ungültige Projekt-ID: ${projectId}`);
  if (sessionId !== undefined && !isUuid(sessionId)) throw new Error(`Ungültige Session-ID: ${sessionId}`);
}

/**
 * File-based persistence under DATA_DIR:
 *   projects/<id>.json               project settings
 *   logs/<projectId>/<sessionId>.jsonl   append-only event log (what the UI replays)
 *   sessions/<projectId>/<sessionId>.json usage statistics per session
 *   media/<hash>.<ext>               images extracted from tool results
 */
export class Store {
  #queues = new Map();

  constructor(dir) {
    this.dir = dir;
  }

  async init() {
    for (const d of ['projects', 'logs', 'sessions', 'media', 'browser', 'probe', 'meta']) {
      await fsp.mkdir(path.join(this.dir, d), { recursive: true });
    }
  }

  p(...parts) { return path.join(this.dir, ...parts); }

  /** Serializes all writes to one file. */
  #enqueue(file, job) {
    const prev = this.#queues.get(file) ?? Promise.resolve();
    const next = prev.then(job, job).catch((e) => console.error(`[store] ${path.basename(file)}: ${e.message}`));
    this.#queues.set(file, next);
    next.finally(() => { if (this.#queues.get(file) === next) this.#queues.delete(file); });
    return next;
  }

  async readJson(file, fallback = null) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
  }

  writeJson(file, obj) {
    return this.#enqueue(file, async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const data = JSON.stringify(obj, null, 2);
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, data);
      try {
        await fsp.rename(tmp, file);
      } catch (e) {
        // Windows: a scanner or indexer may briefly lock the target
        if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') {
          await fsp.writeFile(file, data);
          await fsp.rm(tmp, { force: true });
        } else throw e;
      }
    });
  }

  flush() { return Promise.all([...this.#queues.values()]); }

  // ---- projects ---------------------------------------------------------
  projectFile(id) { assertIds(id); return this.p('projects', `${id}.json`); }
  readProject(id) { return this.readJson(this.projectFile(id)); }
  writeProject(meta) { return this.writeJson(this.projectFile(meta.id), meta); }
  async removeProject(id) {
    await this.flush();
    await fsp.rm(this.projectFile(id), { force: true });
  }
  async moveProjectData(id, targetDir) {
    assertIds(id);
    await this.flush();
    for (const sub of ['logs', 'sessions', 'browser']) {
      const src = this.p(sub, id);
      if (fs.existsSync(src)) {
        await fsp.mkdir(targetDir, { recursive: true });
        await fsp.rename(src, path.join(targetDir, sub)).catch(() => fsp.rm(src, { recursive: true, force: true }));
      }
    }
  }

  // ---- event logs -------------------------------------------------------
  logFile(projectId, sessionId) {
    assertIds(projectId, sessionId);
    return this.p('logs', projectId, `${sessionId}.jsonl`);
  }

  appendEvent(projectId, sessionId, ev) {
    const file = this.logFile(projectId, sessionId);
    const line = `${JSON.stringify(ev)}\n`;
    return this.#enqueue(file, async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.appendFile(file, line);
    });
  }

  hasLog(projectId, sessionId) {
    try { return fs.existsSync(this.logFile(projectId, sessionId)); } catch { return false; }
  }

  /** Returns the last `limit` events, or null when no log exists. */
  async readEvents(projectId, sessionId, limit) {
    const file = this.logFile(projectId, sessionId);
    if (!fs.existsSync(file)) return null;
    await this.#queues.get(file);
    const ring = [];
    let total = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      total++;
      ring.push(line);
      if (ring.length > limit) ring.shift();
    }
    const events = [];
    for (const line of ring) {
      try { events.push(JSON.parse(line)); } catch { /* skip a torn last line */ }
    }
    return { events, total, truncated: total > ring.length };
  }

  async listLogs(projectId) {
    assertIds(projectId);
    const dir = this.p('logs', projectId);
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const sessionId = n.slice(0, -6);
      if (!isUuid(sessionId)) continue;
      try {
        const st = await fsp.stat(path.join(dir, n));
        out.push({ sessionId, mtime: st.mtimeMs, size: st.size });
      } catch { /* raced with delete */ }
    }
    return out;
  }

  // ---- session statistics ----------------------------------------------
  statsFile(projectId, sessionId) {
    assertIds(projectId, sessionId);
    return this.p('sessions', projectId, `${sessionId}.json`);
  }
  readStats(projectId, sessionId) { return this.readJson(this.statsFile(projectId, sessionId)); }
  writeStats(projectId, sessionId, stats) { return this.writeJson(this.statsFile(projectId, sessionId), stats); }
}
