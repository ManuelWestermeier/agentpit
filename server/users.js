import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './util.js';

export const USER_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/**
 * Browser users: people the admin lets use one (or more) browser identities through their own page
 * /u/<name> – nothing else of the cockpit (no projects, sessions, files, terminals).
 * Stored in data/users.json, passwords as scrypt hashes; `rev` changes with every new password and
 * signs out that user's sessions. The admin is not in here – it is the cockpit password (auth.json).
 */
export class Users {
  constructor({ dataDir, hashPassword, verifyPassword, validatePassword }) {
    this.file = path.join(dataDir, 'users.json');
    this.hash = hashPassword;
    this.verify = verifyPassword;
    this.validate = validatePassword;
    this.cache = { mtime: -1, list: [] };
  }

  #load() {
    let mtime = 0;
    try { mtime = fs.statSync(this.file).mtimeMs; } catch { mtime = 0; }
    if (mtime !== this.cache.mtime) {
      let list = [];
      try { list = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* none yet */ }
      this.cache = { mtime, list: Array.isArray(list) ? list.filter((u) => USER_RE.test(u?.name)) : [] };
    }
    return this.cache.list;
  }

  #save(list) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
    try { fs.renameSync(tmp, this.file); } catch { fs.copyFileSync(tmp, this.file); fs.rmSync(tmp, { force: true }); }
    this.cache.mtime = -1;
  }

  get(name) { return this.#load().find((u) => u.name === name) ?? null; }

  /** Public view (no hashes). */
  list() {
    return this.#load().map((u) => ({ name: u.name, role: 'browser', browsers: u.browsers ?? [], createdAt: u.createdAt, passwordAt: u.pw?.at ?? null, lastLogin: u.lastLogin ?? null }));
  }

  create({ name, password, browsers }, reserved = []) {
    const n = String(name ?? '').trim().toLowerCase();
    if (!USER_RE.test(n)) throw new UserError('Name: 2–32 Zeichen, a–z, 0–9, Punkt, Minus, Unterstrich.');
    if (reserved.includes(n) || this.get(n)) throw new UserError(`„${n}“ gibt es schon.`);
    const err = this.validate(password);
    if (err) throw new UserError(err);
    const list = this.#load();
    const user = { name: n, pw: this.hash(password, 1), browsers: [...new Set(browsers ?? [])], createdAt: Date.now() };
    this.#save([...list, user]);
    return user;
  }

  setPassword(name, password) {
    const err = this.validate(password);
    if (err) throw new UserError(err);
    const list = this.#load();
    const u = list.find((x) => x.name === name);
    if (!u) throw new UserError('Nutzer gibt es nicht');
    u.pw = this.hash(password, (u.pw?.rev ?? 0) + 1);
    this.#save(list);
  }

  setBrowsers(name, browsers) {
    const list = this.#load();
    const u = list.find((x) => x.name === name);
    if (!u) throw new UserError('Nutzer gibt es nicht');
    u.browsers = [...new Set(browsers)].slice(0, 20);
    this.#save(list);
  }

  remove(name) {
    this.#save(this.#load().filter((u) => u.name !== name));
  }

  /** Password check; returns the user's current revision or null. */
  check(name, password) {
    const u = this.get(name);
    if (!u?.pw || !this.verify(password, u.pw)) return null;
    return u.pw.rev ?? 1;
  }

  rev(name) { return this.get(name)?.pw?.rev ?? null; }

  touchLogin(name) {
    const list = this.#load();
    const u = list.find((x) => x.name === name);
    if (u) { u.lastLogin = Date.now(); this.#save(list); }
  }
}
