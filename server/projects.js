import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isProjectId } from './store.js';
import { slugify, UserError } from './util.js';

const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const TEMPLATE_VARS = ['CLAUDE.md'];
/** Folder next to the projects that every session can read and write (../shared-claude/ from a project). */
export const SHARED_DIR_NAME = 'shared-claude';

/** A project is a folder ./projects/<id>/ plus settings in data/projects/<id>.json. */
export class Projects extends EventEmitter {
  constructor({ config, store }) {
    super();
    this.config = config;
    this.store = store;
  }

  async init() {
    await fsp.mkdir(this.config.projectsDir, { recursive: true });
    const existing = await this.list();
    if (!existing.length) {
      await this.create({ name: 'Erste Schritte' });
    }
  }

  dirOf(id) {
    if (!isProjectId(id)) throw new UserError('Ungültige Projekt-ID');
    return path.join(this.config.projectsDir, id);
  }

  defaults(id, name) {
    const now = Date.now();
    return {
      id,
      name: name || id,
      createdAt: now,
      updatedAt: now,
      model: this.config.defaultModel,
      mode: this.config.defaultMode,
      effort: this.config.defaultEffort,
      browser: { enabled: this.config.browserMcp, headless: true },
      browserProfile: '',
      autoCommit: true,
      hookToken: crypto.randomBytes(24).toString('base64url'),
      lastSessionId: null,
    };
  }

  async list() {
    let entries = [];
    try { entries = await fsp.readdir(this.config.projectsDir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory() || !isProjectId(e.name) || e.name === SHARED_DIR_NAME) continue;
      out.push(await this.#meta(e.name));
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async #meta(id) {
    const stored = await this.store.readProject(id);
    if (stored) {
      if (!stored.hookToken) {
        stored.hookToken = crypto.randomBytes(24).toString('base64url');
        await this.store.writeProject(stored);
      }
      return { ...this.defaults(id), ...stored, id, dir: this.dirOf(id) };
    }
    // Folder created by hand: adopt it
    const meta = this.defaults(id, id);
    await this.store.writeProject(meta);
    return { ...meta, dir: this.dirOf(id) };
  }

  async get(id) {
    if (id === SHARED_DIR_NAME) throw new UserError('Der gemeinsame Ordner ist kein Projekt');
    const dir = this.dirOf(id);
    if (!fs.existsSync(dir)) throw new UserError(`Projekt ${id} existiert nicht`);
    return this.#meta(id);
  }

  async create(input = {}) {
    const name = String(input.name ?? '').trim().slice(0, 80);
    if (!name) throw new UserError('Name fehlt');
    const base = slugify(name);
    let id = base;
    for (let i = 2; id === SHARED_DIR_NAME || fs.existsSync(path.join(this.config.projectsDir, id)); i++) id = `${base}-${i}`;
    const dir = this.dirOf(id);

    await fsp.mkdir(dir, { recursive: true });
    const tpl = path.join(this.config.templatesDir, 'default');
    if (fs.existsSync(tpl)) {
      await fsp.cp(tpl, dir, { recursive: true, force: false, errorOnExist: false });
      for (const f of TEMPLATE_VARS) {
        const file = path.join(dir, f);
        if (!fs.existsSync(file)) continue;
        const text = await fsp.readFile(file, 'utf8');
        await fsp.writeFile(file, text.replaceAll('{{PROJECT_NAME}}', name));
      }
    }
    for (const sub of ['input', 'output']) await fsp.mkdir(path.join(dir, sub), { recursive: true });

    const meta = { ...this.defaults(id, name), ...this.#sanitizePatch(input) };
    await this.store.writeProject(meta);
    if (input.git !== false) await this.git?.init(id).catch((e) => console.warn(`[git] ${id}: ${e.message}`));
    this.emit('change');
    return { ...meta, dir };
  }

  #sanitizePatch(p = {}) {
    const out = {};
    if (typeof p.name === 'string' && p.name.trim()) out.name = p.name.trim().slice(0, 80);
    if (typeof p.model === 'string') out.model = p.model.trim().slice(0, 100);
    if (typeof p.mode === 'string') {
      if (!this.config.permissionModes.includes(p.mode)) throw new UserError('Unbekannter Berechtigungsmodus');
      if (p.mode === 'bypassPermissions' && !this.config.allowBypass) {
        throw new UserError('bypassPermissions ist gesperrt (ALLOW_BYPASS_PERMISSIONS=true in .env setzen)');
      }
      out.mode = p.mode;
    }
    if (typeof p.effort === 'string') {
      if (!EFFORTS.includes(p.effort)) throw new UserError('Unbekannte Effort-Stufe');
      out.effort = p.effort;
    }
    if (p.browser && typeof p.browser === 'object') {
      out.browser = { enabled: p.browser.enabled !== false, headless: p.browser.headless === true };
    }
    if (typeof p.browserProfile === 'string') {
      if (p.browserProfile && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(p.browserProfile)) throw new UserError('Ungültiges Browser-Profil');
      out.browserProfile = p.browserProfile;
    }
    if (typeof p.autoCommit === 'boolean') out.autoCommit = p.autoCommit;
    // sub-session: started by another project's Claude (shown as its child)
    if (typeof p.parentId === 'string' && (p.parentId === '' || isProjectId(p.parentId))) out.parentId = p.parentId;
    if (p.rotateHookToken === true) out.hookToken = crypto.randomBytes(24).toString('base64url');
    return out;
  }

  async update(id, patch) {
    const meta = await this.get(id);
    const next = { ...meta, ...this.#sanitizePatch(patch), updatedAt: Date.now() };
    delete next.dir;
    await this.store.writeProject(next);
    this.emit('change');
    return { ...next, dir: meta.dir };
  }

  /** Internal bookkeeping without bumping list order noisily. */
  async touch(id, patch = {}) {
    const meta = await this.get(id).catch(() => null);
    if (!meta) return;
    const next = { ...meta, ...patch, updatedAt: Date.now() };
    delete next.dir;
    await this.store.writeProject(next);
    this.emit('change');
  }

  /** Moves the folder and its data to ./trash — nothing is deleted. */
  async remove(id) {
    const dir = this.dirOf(id);
    if (!fs.existsSync(dir)) throw new UserError('Projekt existiert nicht');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.config.trashDir, `${id}-${stamp}`);
    await fsp.mkdir(this.config.trashDir, { recursive: true });
    await fsp.rename(dir, path.join(target + '-files')).catch(async (e) => {
      if (e.code === 'EXDEV') {
        await fsp.cp(dir, target + '-files', { recursive: true });
        await fsp.rm(dir, { recursive: true, force: true });
      } else if (e.code === 'EPERM' || e.code === 'EBUSY') {
        throw new UserError('Ordner ist gesperrt (läuft noch ein Programm darin, z. B. Explorer oder ein Terminal?)');
      } else throw e;
    });
    await this.store.moveProjectData(id, target + '-data');
    await this.store.removeProject(id);
    this.emit('change');
    return { trashedTo: target };
  }
}
