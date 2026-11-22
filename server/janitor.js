import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SHARED_DIR_NAME } from './projects.js';

const DAY = 86_400_000;
const MEDIA_RE = /\.(webm|mp4|mov|mkv|png|jpe?g|webp|gif|pdf)$/i;

/**
 * Pure caches inside a Chromium profile – safe to delete while the browser is not running: rebuilt on
 * demand, no logins, cookies, history, passwords, extensions or site data (IndexedDB/localStorage).
 */
const PROFILE_CACHES = [
  'Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/DawnCache', 'Default/DawnGraphiteCache',
  'Default/DawnWebGPUCache', 'Default/Service Worker/CacheStorage', 'Default/Service Worker/ScriptCache',
  'GrShaderCache', 'ShaderCache', 'GraphiteDawnCache', 'GPUPersistentCache', 'component_crx_cache',
  'extensions_crx_cache', 'Crashpad/reports', 'BrowserMetrics',
];

/** "<name>-2026-11-22T17-28-05-369Z[-files|…]" → ms, as written by projects/browsers remove(). */
export function trashTime(name) {
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(t) ? t : null;
}

async function walk(dir, visit) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue; // never follow links out of the folder
    if (e.isDirectory()) await walk(p, visit);
    else if (e.isFile()) await visit(p);
  }
}

async function dirSize(dir) {
  let total = 0;
  await walk(dir, async (f) => { try { total += (await fsp.stat(f)).size; } catch { /* gone */ } });
  return total;
}

/** Removes empty sub-folders (not `root` itself). */
async function pruneEmpty(root) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const p = path.join(root, e.name);
    await pruneEmpty(p);
    try { if (!(await fsp.readdir(p)).length) await fsp.rmdir(p); } catch { /* not empty / gone */ }
  }
}

/**
 * Automatic cleanup – runs shortly after start and then every 6 hours; browser caches also right
 * after an identity's browser stops. Deletes only what is regenerated or marked as disposable:
 *  - output/browser/ (Playwright artefacts): snapshots/logs/traces after BROWSER_ARTIFACT_DAYS,
 *    recordings/screenshots after BROWSER_MEDIA_DAYS
 *  - work/ (intermediate files, "darf gelöscht werden") after WORK_DAYS
 *  - output/ results only if OUTPUT_DAYS > 0 (default: kept forever)
 *  - trash/ entries after TRASH_DAYS
 *  - browser caches of identities that are not running, once above PROFILE_CACHE_MB
 * Never touched: input/, project sources, .git/.claude, ../shared-claude/, logins/cookies/extensions.
 */
export class Janitor {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = null;
    this.running = null;
    this.last = null;
    this.jobs = new Map(); // identity id → cache cleanup in progress
  }

  start() {
    if (!this.ctx.config.cleanup) return;
    const first = setTimeout(() => this.run().catch(() => {}), 2 * 60_000);
    first.unref?.();
    this.timer = setInterval(() => this.run().catch(() => {}), 6 * 3600_000);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  /** One full pass; returns { freedMb, files, details }. Concurrent calls share the running pass. */
  run(now = Date.now(), { dryRun = false } = {}) {
    if (dryRun) return this.#run(now, true);
    this.running ??= this.#run(now, false).finally(() => { this.running = null; });
    return this.running;
  }

  async #run(now, dryRun) {
    const { config } = this.ctx;
    const report = { at: now, dryRun, freed: 0, files: 0, details: [] };
    const del = async (file, why) => {
      try {
        const st = await fsp.stat(file);
        if (!dryRun) await fsp.rm(file, { force: true });
        report.freed += st.size;
        report.files++;
        report.details.push(`${why}: ${path.relative(this.ctx.root, file)}`);
      } catch { /* locked or gone – next pass */ }
    };
    const olderThan = async (file, days) => {
      try { return now - (await fsp.stat(file)).mtimeMs > days * DAY; } catch { return false; }
    };

    // ---- projects
    let entries = [];
    try { entries = await fsp.readdir(config.projectsDir, { withFileTypes: true }); } catch { /* none */ }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === SHARED_DIR_NAME) continue;
      const dir = path.join(config.projectsDir, e.name);
      // a session that is working right now may still need its fresh intermediate files
      const busy = ['running', 'waiting', 'starting'].includes(this.ctx.runners?.peek(e.name)?.state);
      const browserOut = path.join(dir, 'output', 'browser');
      await walk(browserOut, async (f) => {
        const media = MEDIA_RE.test(f);
        if (await olderThan(f, media ? config.browserMediaDays : config.browserArtifactDays)) await del(f, media ? 'Browser-Aufnahme' : 'Browser-Artefakt');
      });
      await pruneEmpty(browserOut);
      for (const extra of ['.playwright-mcp']) { // stray Playwright output folders
        await walk(path.join(dir, extra), async (f) => { if (await olderThan(f, config.browserArtifactDays)) await del(f, 'Browser-Artefakt'); });
        await pruneEmpty(path.join(dir, extra));
      }
      if (!busy) {
        const work = path.join(dir, 'work');
        await walk(work, async (f) => { if (await olderThan(f, config.workDays)) await del(f, 'Zwischenstand'); });
        await pruneEmpty(work);
      }
      if (config.outputDays > 0) {
        const out = path.join(dir, 'output');
        await walk(out, async (f) => {
          if (f.startsWith(browserOut + path.sep)) return;
          if (await olderThan(f, config.outputDays)) await del(f, 'altes Ergebnis');
        });
        await pruneEmpty(out);
      }
    }

    // ---- trash (deleted projects and identities)
    try {
      for (const t of await fsp.readdir(config.trashDir, { withFileTypes: true })) {
        const p = path.join(config.trashDir, t.name);
        const st = await fsp.stat(p).catch(() => null);
        if (!st) continue;
        // age = when it was moved to the trash (time stamp in the name) – a moved folder keeps its old mtime
        const deletedAt = trashTime(t.name) ?? st.mtimeMs;
        if (now - deletedAt <= config.trashDays * DAY) continue;
        const size = st.isDirectory() ? await dirSize(p) : st.size;
        await (dryRun ? Promise.resolve() : fsp.rm(p, { recursive: true, force: true })).then(() => {
          report.freed += size;
          report.files++;
          report.details.push(`Papierkorb (> ${config.trashDays} Tage): ${t.name}`);
        }).catch(() => {});
      }
    } catch { /* no trash yet */ }

    // ---- browser caches of identities that are not running
    for (const id of this.ctx.browsers?.profiles.keys() ?? []) {
      if (!this.ctx.browsers.running.has(id)) report.freed += await this.cleanProfile(id, report, dryRun);
    }

    report.freedMb = Math.round(report.freed / 1024 / 1024);
    if (dryRun) return report;
    this.last = report;
    if (report.files) console.log(`[aufräumen] ${report.files} Dateien/Ordner gelöscht, ${report.freedMb} MB frei`);
    return report;
  }

  /**
   * Empties the pure caches of one identity's profile when they exceed PROFILE_CACHE_MB.
   * Only when that browser is not running. Returns freed bytes.
   */
  cleanProfile(id, report = null, dryRun = false) {
    if (dryRun) return this.#cleanProfile(id, report, true);
    // the browser start waits for this (Browsers#start → profileJob)
    const job = this.#cleanProfile(id, report, false).finally(() => { if (this.jobs.get(id) === job) this.jobs.delete(id); });
    this.jobs.set(id, job);
    return job;
  }

  /** Running cache cleanup of an identity, if any – a browser start awaits it. */
  profileJob(id) {
    return this.jobs.get(id) ?? null;
  }

  async #cleanProfile(id, report, dryRun) {
    const b = this.ctx.browsers;
    if (!b?.profiles.has(id) || b.running.has(id) || b.profileInUse(id)) return 0; // browser (still) open
    const dir = b.dir(id);
    if (!fs.existsSync(dir)) return 0;
    const sizes = await Promise.all(PROFILE_CACHES.map(async (c) => [c, await dirSize(path.join(dir, c))]));
    const total = sizes.reduce((s, [, n]) => s + n, 0);
    if (total < this.ctx.config.profileCacheMb * 1024 * 1024) return 0;
    if (dryRun) {
      report?.details.push(`Browser-Cache „${b.profiles.get(id)?.name ?? id}“: ${Math.round(total / 1024 / 1024)} MB`);
      if (report) report.files++;
      return total;
    }
    let freed = 0;
    for (const [c, n] of sizes) {
      if (!n) continue;
      await fsp.rm(path.join(dir, c), { recursive: true, force: true }).then(() => { freed += n; }).catch(() => {});
    }
    if (report && freed) {
      report.files++;
      report.details.push(`Browser-Cache „${b.profiles.get(id)?.name ?? id}“: ${Math.round(freed / 1024 / 1024)} MB`);
    }
    if (freed) console.log(`[aufräumen] Browser-Cache „${b.profiles.get(id)?.name ?? id}“ geleert: ${Math.round(freed / 1024 / 1024)} MB`);
    return freed;
  }
}
