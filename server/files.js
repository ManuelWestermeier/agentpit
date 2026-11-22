import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UserError } from './util.js';

const IGNORE_WATCH = /(^|[\\/])(node_modules|\.git|\.cache|__pycache__)([\\/]|$)/;
const MAX_ENTRIES = 1000;
const UPLOAD_NAME_RE = /[^\p{L}\p{N}._ -]+/gu;

/** Project file access: listing, watching and path-guarded resolution. */
export class Files {
  constructor(ctx) {
    this.ctx = ctx;
    this.watchers = new Map();
    this.timers = new Map();
  }

  /** Resolves `rel` inside the project folder; rejects traversal and symlinks pointing outside. */
  async resolve(projectId, rel = '') {
    const root = await fsp.realpath(this.ctx.projects.dirOf(projectId));
    const clean = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean.includes('\0')) throw new UserError('Ungültiger Pfad');
    const abs = path.resolve(root, clean);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new UserError('Pfad außerhalb des Projekts');
    let real = abs;
    try { real = await fsp.realpath(abs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (real !== root && !real.startsWith(root + path.sep)) throw new UserError('Pfad außerhalb des Projekts');
    return { root, abs: real, rel: path.relative(root, real).split(path.sep).join('/') };
  }

  async list(projectId, rel = '') {
    const { abs, rel: relClean } = await this.resolve(projectId, rel);
    let ents;
    try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) {
      if (e.code === 'ENOENT') throw new UserError('Ordner existiert nicht');
      if (e.code === 'ENOTDIR') throw new UserError('Kein Ordner');
      throw e;
    }
    const out = [];
    for (const e of ents.slice(0, MAX_ENTRIES)) {
      const full = path.join(abs, e.name);
      let st = null;
      try { st = await fsp.stat(full); } catch { continue; }
      out.push({
        name: e.name,
        path: relClean ? `${relClean}/${e.name}` : e.name,
        dir: st.isDirectory(),
        size: st.isDirectory() ? null : st.size,
        mtime: st.mtimeMs,
      });
    }
    out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'de') : a.dir ? -1 : 1));
    return { path: relClean, entries: out, truncated: ents.length > MAX_ENTRIES };
  }

  /** Recently changed media/output files – the "what did Claude produce" view. */
  async recentOutputs(projectId, limit = 40) {
    const { abs } = await this.resolve(projectId, 'output');
    const found = [];
    const walk = async (dir, depth) => {
      if (depth > 4 || found.length > 2000) return;
      let ents = [];
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else {
          try {
            const st = await fsp.stat(full);
            found.push({ name: e.name, path: path.relative(path.dirname(abs), full).split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs, dir: false });
          } catch { /* vanished */ }
        }
      }
    };
    await walk(abs, 0);
    return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  }

  /** Streams an upload into input/<name> (unique name, size-limited). Returns the project-relative path. */
  async saveUploadStream(projectId, name, stream, maxBytes) {
    const base = path.basename(String(name ?? 'upload').replace(/\\/g, '/')).replace(UPLOAD_NAME_RE, '_').replace(/^\.+/, '').slice(0, 120) || 'upload';
    const { abs: dir } = await this.resolve(projectId, 'input');
    await fsp.mkdir(dir, { recursive: true });
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let candidate = base;
    for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${stem}-${i}${ext}`;
    const target = path.join(dir, candidate);
    let size = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) cb(new UserError(`Datei zu groß (max. ${Math.round(maxBytes / 1024 ** 3)} GB)`));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(stream, limiter, fs.createWriteStream(target, { flags: 'wx' }));
    } catch (e) {
      await fsp.rm(target, { force: true });
      throw e;
    }
    if (!size) {
      await fsp.rm(target, { force: true });
      throw new UserError('Leere Datei');
    }
    this.touched(projectId);
    return `input/${candidate}`;
  }

  touched(projectId) {
    clearTimeout(this.timers.get(projectId));
    this.timers.set(projectId, setTimeout(() => {
      this.timers.delete(projectId);
      this.ctx.hub.toProject(projectId, { t: 'files', projectId });
    }, 700));
  }

  watch(projectId) {
    if (this.watchers.has(projectId)) return;
    try {
      const w = fs.watch(this.ctx.projects.dirOf(projectId), { recursive: true }, (_evt, name) => {
        if (name && IGNORE_WATCH.test(String(name))) return;
        this.touched(projectId);
      });
      w.on('error', () => this.unwatch(projectId));
      this.watchers.set(projectId, w);
    } catch { /* recursive watch unsupported – updates arrive after each turn instead */ }
  }

  unwatch(projectId) {
    this.watchers.get(projectId)?.close();
    this.watchers.delete(projectId);
  }

  closeAll() {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }
}
