import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { UserError } from './util.js';

// ------------------------------------------------------------------ cron (5 fields, local time)

const FIELDS = [
  { name: 'Minute', min: 0, max: 59 },
  { name: 'Stunde', min: 0, max: 23 },
  { name: 'Tag', min: 1, max: 31 },
  { name: 'Monat', min: 1, max: 12 },
  { name: 'Wochentag', min: 0, max: 7 }, // 0 and 7 = Sunday
];
const ALIASES = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' };

/** Parses "m h dom mon dow" (*, n, a-b, *\/n, a-b/n, lists). Throws a UserError with a German message. */
export function parseCron(expr) {
  const src = ALIASES[String(expr).trim()] ?? String(expr).trim();
  const parts = src.split(/\s+/);
  if (parts.length !== 5) throw new UserError('Cron braucht 5 Felder: Minute Stunde Tag Monat Wochentag – z. B. "0 9 * * 1-5"');
  const sets = parts.map((part, i) => {
    const f = FIELDS[i];
    const set = new Set();
    for (const item of part.split(',')) {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
      if (!m) throw new UserError(`Cron-Feld ${f.name}: „${item}“ verstehe ich nicht`);
      let [lo, hi] = m[1] === '*' ? [f.min, f.max] : m[1].split('-').map(Number);
      if (hi === undefined) hi = m[2] ? f.max : lo;
      const step = m[2] ? Number(m[2]) : 1;
      if (lo < f.min || hi > f.max || lo > hi || step < 1) throw new UserError(`Cron-Feld ${f.name}: ${item} außerhalb ${f.min}–${f.max}`);
      for (let v = lo; v <= hi; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    return set;
  });
  return { minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4], domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

/** Next time (ms) strictly after `from` that matches the cron expression. */
export function nextCron(expr, from = Date.now()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const end = from + 400 * 86400_000;
  while (d.getTime() < end) {
    if (!c.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    // standard cron: when both day fields are restricted, either one matching is enough
    const domOk = c.dom.has(d.getDate()), dowOk = c.dow.has(d.getDay());
    const dayOk = c.domAny && c.dowAny ? true : c.domAny ? dowOk : c.dowAny ? domOk : domOk || dowOk;
    if (!dayOk) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  throw new UserError('Cron-Ausdruck trifft in den nächsten 400 Tagen nie zu');
}

// ------------------------------------------------------------------ schedules

const KINDS = ['cron', 'every', 'at'];
const MAX_SCHEDULES = 200;

/**
 * Timed prompts: at a time / every n minutes / cron → a prompt is sent to a project's Claude session.
 * Created by the user in the UI or by Claude itself (cockpit MCP). Stored in data/schedules.json.
 * Runs missed while the cockpit was off are not caught up (no flood after a restart); a one-off
 * ("at") missed by less than 6 h still runs once.
 */
export class Schedules extends EventEmitter {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.file = ctx.store.p('schedules.json');
    this.items = [];
    this.timer = null;
  }

  async init() {
    const saved = await this.ctx.store.readJson(this.file, []);
    this.items = Array.isArray(saved) ? saved : [];
    const now = Date.now();
    for (const s of this.items) {
      if (!s.enabled) continue;
      if (s.kind === 'at' && s.nextRun && s.nextRun < now - 6 * 3600_000) { s.enabled = false; s.lastError = 'verpasst (Cockpit war aus)'; }
      else if (s.kind !== 'at' && s.nextRun && s.nextRun < now) s.nextRun = this.#next(s, now);
    }
    await this.#save();
    this.timer = setInterval(() => this.tick().catch((e) => console.warn(`[zeitplan] ${e.message}`)), 15_000);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  list(projectId) {
    return this.items.filter((s) => !projectId || s.projectId === projectId).map((s) => ({ ...s }));
  }

  #clean(input, base = {}) {
    const out = { ...base };
    if (input.name !== undefined) out.name = String(input.name ?? '').trim().slice(0, 80);
    if (input.prompt !== undefined) {
      out.prompt = String(input.prompt ?? '').trim();
      if (!out.prompt) throw new UserError('Prompt fehlt');
      if (out.prompt.length > 50_000) throw new UserError('Prompt zu lang (max. 50 000 Zeichen)');
    }
    if (input.kind !== undefined) {
      if (!KINDS.includes(input.kind)) throw new UserError('Art: cron, every (alle n Minuten) oder at (einmalig)');
      out.kind = input.kind;
    }
    if (input.cron !== undefined) out.cron = String(input.cron).trim();
    if (input.everyMinutes !== undefined) out.everyMinutes = Math.round(Number(input.everyMinutes));
    if (input.at !== undefined) {
      const t = typeof input.at === 'number' ? input.at : Date.parse(String(input.at));
      if (!Number.isFinite(t)) throw new UserError('Zeitpunkt nicht lesbar – ISO-Format, z. B. 2026-11-23T09:00');
      out.at = t;
    }
    if (typeof input.enabled === 'boolean') out.enabled = input.enabled;
    if (out.kind === 'cron') parseCron(out.cron ?? '');
    if (out.kind === 'every' && !(out.everyMinutes >= 1 && out.everyMinutes <= 525_600)) throw new UserError('everyMinutes: 1 bis 525600');
    if (out.kind === 'at' && !out.at) throw new UserError('Zeitpunkt (at) fehlt');
    return out;
  }

  #next(s, from = Date.now()) {
    if (s.kind === 'cron') return nextCron(s.cron, from);
    if (s.kind === 'every') return from + s.everyMinutes * 60_000;
    return s.at;
  }

  async create(projectId, input, createdBy = 'Nutzer') {
    await this.ctx.projects.get(projectId); // exists
    if (this.items.length >= MAX_SCHEDULES) throw new UserError(`Maximal ${MAX_SCHEDULES} Zeitpläne`);
    const s = this.#clean({ enabled: true, ...input }, { id: crypto.randomBytes(6).toString('hex'), projectId, createdAt: Date.now(), createdBy: String(createdBy).slice(0, 60), runs: 0, lastRun: null, lastError: null });
    if (!s.kind) throw new UserError('Art fehlt: cron, every oder at');
    if (!s.prompt) throw new UserError('Prompt fehlt');
    if (!s.name) s.name = s.prompt.split('\n')[0].slice(0, 60);
    if (s.kind === 'at' && s.at < Date.now() - 60_000) throw new UserError('Zeitpunkt liegt in der Vergangenheit');
    s.nextRun = this.#next(s);
    this.items.push(s);
    await this.#save();
    return { ...s };
  }

  async update(id, patch) {
    const i = this.items.findIndex((s) => s.id === id);
    if (i < 0) throw new UserError('Zeitplan nicht gefunden');
    const s = this.#clean(patch, this.items[i]);
    s.nextRun = s.enabled ? this.#next(s) : null;
    this.items[i] = s;
    await this.#save();
    return { ...s };
  }

  async remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((s) => s.id !== id);
    if (this.items.length === before) throw new UserError('Zeitplan nicht gefunden');
    await this.#save();
  }

  /** Project deleted → its schedules go too. */
  async dropProject(projectId) {
    this.items = this.items.filter((s) => s.projectId !== projectId);
    await this.#save();
  }

  async runNow(id) {
    const s = this.items.find((x) => x.id === id);
    if (!s) throw new UserError('Zeitplan nicht gefunden');
    try { await this.#fire(s, Date.now(), true); } finally { await this.#save(); }
  }

  async tick(now = Date.now()) {
    let changed = false;
    for (const s of this.items) {
      if (!s.enabled || !s.nextRun || s.nextRun > now) continue;
      await this.#fire(s, now, false);
      changed = true;
    }
    if (changed) await this.#save();
  }

  async #fire(s, now, manual) {
    try {
      const runner = await this.ctx.runners.get(s.projectId);
      await runner.send(`[Zeitplan „${s.name}“${manual ? ', manuell ausgelöst' : ''}]\n${s.prompt}`, { source: 'Zeitplan' });
      s.runs++;
      s.lastRun = now;
      s.lastError = null;
    } catch (e) {
      s.lastError = e.message.slice(0, 300);
      if (!manual) { s.nextRun = now + 60_000; return; } // e.g. MAX_RUNNERS reached → retry in a minute
      throw e;
    }
    if (manual) return;
    if (s.kind === 'at') { s.enabled = false; s.nextRun = null; } else s.nextRun = this.#next(s, now);
  }

  async #save() {
    await this.ctx.store.writeJson(this.file, this.items);
    this.emit('change');
  }
}
