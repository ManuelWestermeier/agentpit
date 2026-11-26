import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Files } from '../server/files.js';
import { Limits } from '../server/limits.js';
import { chartFromRows, renderChart } from '../server/charts.js';
import { Janitor, trashTime } from '../server/janitor.js';
import { Media } from '../server/media.js';
import { Meta } from '../server/meta.js';
import { Projects, SHARED_DIR_NAME } from '../server/projects.js';
import { Schedules, nextCron, parseCron } from '../server/schedules.js';
import { parseCookies } from '../server/security.js';
import { diffModelUsage, parsePrice } from '../server/session-stats.js';
import { Store } from '../server/store.js';
import { AsyncQueue, safeEqual, slugify } from '../server/util.js';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `cockpit-${name}-`));

test('slugify keeps German names readable', () => {
  assert.equal(slugify('Promo Küin Reel'), 'promo-kuein-reel');
  assert.equal(slugify('  Straße / Öl  '), 'strasse-oel');
  assert.equal(slugify('***'), 'projekt');
});

test('parsePrice reads list prices from model descriptions', () => {
  assert.deepEqual(parsePrice('Opus 5.5 · Best for everyday tasks · $4/$20 per Mtok'), { in: 4, out: 20 });
  assert.deepEqual(parsePrice('Haiku · $0.8/$4 per Mtok'), { in: 0.8, out: 4 });
  assert.equal(parsePrice('no price here'), null);
});

test('diffModelUsage returns per-model deltas of cumulative counters', () => {
  const a = { m: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, costUSD: 0.1 } };
  const b = { m: { inputTokens: 15, outputTokens: 9, cacheReadInputTokens: 300, cacheCreationInputTokens: 20, costUSD: 0.25 } };
  const d = diffModelUsage(a, b).m;
  assert.equal(d.in, 5);
  assert.equal(d.out, 4);
  assert.equal(d.cacheRead, 200);
  assert.equal(d.cacheWrite, 0);
  assert.ok(Math.abs(d.cost - 0.15) < 1e-9);
});

test('Limits forecast: burn rate, ETA and percent per USD', async () => {
  const store = new Store(tmp('limits'));
  await store.init();
  const limits = new Limits({ store });
  const reset = Date.now() + 2 * 3600_000;
  const realNow = Date.now;
  const t0 = realNow() - 30 * 60_000;
  try {
    for (let i = 0; i <= 6; i++) {
      Date.now = () => t0 + i * 5 * 60_000;      // every 5 minutes
      limits.addCost(0.5);                          // $0.50 per step
      limits.ingestUsage({ rate_limits_available: true, subscription_type: 'max', rate_limits: { five_hour: { utilization: 20 + i * 2, resets_at: new Date(reset).toISOString() } } });
    }
  } finally {
    Date.now = realNow;
  }
  const f = limits.forecast();
  assert.ok(Math.abs(f.five_hour.perHour - 24) < 0.5, `perHour ${f.five_hour.perHour}`); // 2 % per 5 min
  assert.ok(f.five_hour.eta > Date.now());
  assert.ok(Math.abs(f.pctPerUsd5h - 4) < 0.01, `pctPerUsd ${f.pctPerUsd5h}`);    // 2 % per $0.50
});

test('Files.resolve blocks traversal and symlinks out of the project', async () => {
  const root = tmp('files');
  const projectsDir = path.join(root, 'projects');
  fs.mkdirSync(path.join(projectsDir, 'demo', 'output'), { recursive: true });
  fs.writeFileSync(path.join(root, 'secret.txt'), 'x');
  const ctx = { projects: { dirOf: (id) => path.join(projectsDir, id) }, hub: { toProject() {} } };
  const files = new Files(ctx);
  assert.equal((await files.resolve('demo', 'output')).rel, 'output');
  await assert.rejects(files.resolve('demo', '../../secret.txt'), /außerhalb/);
  await assert.rejects(files.resolve('demo', '..\\..\\secret.txt'), /außerhalb/);
  try {
    fs.symlinkSync(path.join(root, 'secret.txt'), path.join(projectsDir, 'demo', 'link.txt'));
    await assert.rejects(files.resolve('demo', 'link.txt'), /außerhalb/);
  } catch (e) {
    if (e.code !== 'EPERM') throw e; // Windows without symlink rights
  }
});

test('Media.sanitize extracts base64 images and truncates huge strings', async () => {
  const dir = tmp('media');
  const media = new Media(dir);
  const png = Buffer.alloc(2000, 7).toString('base64');
  const out = await media.sanitize({ content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }], big: 'a'.repeat(250_000) });
  assert.match(out.content[0].source.url, /^\/media\/[0-9a-f]{24}\.png$/);
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.ok(out.big.length < 210_000);
});

test('cookie parsing and constant-time compare', () => {
  assert.deepEqual(parseCookies('a=1; cockpit=abc%3D; bad'), { a: '1', cockpit: 'abc=' });
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', undefined));
});

test('cron: parse errors in German, next run follows standard cron rules', () => {
  assert.throws(() => parseCron('* * *'), /5 Felder/);
  assert.throws(() => parseCron('61 * * * *'), /Minute/);
  assert.throws(() => parseCron('0 9 * * x'), /Wochentag/);
  const base = new Date(2026, 10, 20, 8, 30).getTime(); // Fri 20 Nov 2026, 08:30 local
  const at = (t) => { const d = new Date(t); return [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getDay()]; };
  assert.deepEqual(at(nextCron('0 9 * * 1-5', base)), [11, 20, 9, 0, 5]);        // today 09:00
  assert.deepEqual(at(nextCron('0 9 * * 1-5', base + 3600_000)), [11, 23, 9, 0, 1]); // after 09:30 → Monday
  assert.deepEqual(at(nextCron('*/15 * * * *', base)), [11, 20, 8, 45, 5]);
  assert.deepEqual(at(nextCron('0 0 1 * *', base)), [12, 1, 0, 0, 2]);
  assert.deepEqual(at(nextCron('30 8 * * 0,7', base)), [11, 22, 8, 30, 0]);       // 7 = Sunday too
  assert.deepEqual(at(nextCron('@daily', base)), [11, 21, 0, 0, 6]);
  // both day fields restricted → either matches (the 1st, or any Monday)
  assert.deepEqual(at(nextCron('0 12 1 * 1', base)), [11, 23, 12, 0, 1]);
});

test('Schedules: fire due prompts, one-offs disable themselves, failures retry', async () => {
  const store = new Store(tmp('sched'));
  await store.init();
  const sent = [];
  let fail = false;
  const ctx = {
    store,
    projects: { get: async (id) => { if (id !== 'demo') throw new Error('nope'); return { id }; } },
    runners: { get: async () => ({ send: async (text) => { if (fail) throw new Error('Schon 6 Sessions aktiv'); sent.push(text); } }) },
  };
  const s = new Schedules(ctx);
  await s.init();
  s.stop();
  const now = Date.now();
  const every = await s.create('demo', { kind: 'every', everyMinutes: 5, prompt: 'Status prüfen', name: 'Check' });
  const once = await s.create('demo', { kind: 'at', at: new Date(now + 60_000).toISOString(), prompt: 'Einmal' });
  await assert.rejects(s.create('demo', { kind: 'cron', cron: 'kaputt', prompt: 'x' }), /5 Felder/);
  await assert.rejects(s.create('demo', { kind: 'at', at: '2001-01-01T00:00', prompt: 'x' }), /Vergangenheit/);
  await s.tick(now + 2 * 60_000);
  assert.deepEqual(sent.map((t) => t.split('\n')[1]), ['Einmal']);
  assert.equal(s.list().find((x) => x.id === once.id).enabled, false);
  await s.tick(now + 6 * 60_000);
  assert.ok(sent.at(-1).startsWith('[Zeitplan „Check“]'));
  fail = true;
  await s.tick(now + 12 * 60_000);
  const e = s.list().find((x) => x.id === every.id);
  assert.match(e.lastError, /Sessions aktiv/);
  assert.ok(e.nextRun <= now + 13 * 60_000, 'retry within a minute');
  // persisted
  const again = new Schedules(ctx);
  await again.init();
  again.stop();
  assert.equal(again.list().length, 2);
});

test('Projects: shared-claude folder is never a project', async () => {
  const root = tmp('proj');
  const store = new Store(path.join(root, 'data'));
  await store.init();
  const projects = new Projects({ config: { projectsDir: path.join(root, 'projects'), templatesDir: path.join(root, 'tpl'), defaultModel: '', defaultMode: 'default', defaultEffort: '', browserMcp: true, permissionModes: ['default'], allowBypass: false }, store });
  fs.mkdirSync(path.join(root, 'projects', SHARED_DIR_NAME), { recursive: true });
  const p = await projects.create({ name: 'Shared Claude', git: false });
  assert.notEqual(p.id, SHARED_DIR_NAME);
  const ids = (await projects.list()).map((x) => x.id);
  assert.ok(!ids.includes(SHARED_DIR_NAME), ids.join(','));
  await assert.rejects(projects.get(SHARED_DIR_NAME), /kein Projekt/);
  const child = await projects.create({ name: 'Kind', parentId: p.id, git: false });
  assert.equal(child.parentId, p.id);
});

test('Janitor: deletes only disposable files, keeps results, inputs, shared folder and logins', async () => {
  const root = tmp('janitor');
  const projectsDir = path.join(root, 'projects'), trashDir = path.join(root, 'trash');
  const now = Date.now(), DAY = 86_400_000;
  const file = (rel, ageDays, size = 10) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x'.repeat(size));
    const t = new Date(now - ageDays * DAY);
    fs.utimesSync(f, t, t);
    return f;
  };
  const oldSnap = file('projects/a/output/browser/page-1.yml', 3);
  const newSnap = file('projects/a/output/browser/page-2.yml', 1);
  const oldVideo = file('projects/a/output/browser/rec.webm', 8);
  const newVideo = file('projects/a/output/browser/rec2.webm', 5);
  const oldWork = file('projects/a/work/tmp/frame.png', 20);
  const newWork = file('projects/a/work/cut.mp4', 3);
  const result = file('projects/a/output/final.mp4', 400);
  const input = file('projects/a/input/source.mov', 400);
  const shared = file('projects/shared-claude/work/notes.md', 400);
  const busyWork = file('projects/busy/work/render.tmp', 30);
  const trashOld = path.join(trashDir, 'alt-2025-01-01T10-00-00-000Z-files');
  const trashNew = path.join(trashDir, `neu-${new Date(now - 2 * DAY).toISOString().replace(/[:.]/g, '-')}-files`);
  for (const d of [trashOld, trashNew]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'f'), 'x'); }
  // identity profile: big cache (deleted) next to cookies/extensions (kept)
  const prof = path.join(root, 'data', 'browsers', 'konto');
  const cache = file('data/browsers/konto/Default/Cache/data_1', 1, 2048);
  const cookies = file('data/browsers/konto/Default/Network/Cookies', 1, 2048);
  const ext = file('data/browsers/konto/Default/Extensions/abc/1.0/manifest.json', 1, 2048);
  const ctx = {
    root,
    config: { projectsDir, trashDir, cleanup: true, trashDays: 30, browserArtifactDays: 2, browserMediaDays: 7, workDays: 14, outputDays: 0, profileCacheMb: 0.001 },
    runners: { peek: (id) => (id === 'busy' ? { state: 'running' } : null) },
    browsers: { profiles: new Map([['konto', { name: 'Konto' }]]), running: new Map(), dir: () => prof, profileInUse: () => false },
  };
  const r = await new Janitor(ctx).run(now);
  const gone = (f) => !fs.existsSync(f);
  assert.ok(gone(oldSnap) && gone(oldVideo) && gone(oldWork) && gone(cache) && gone(trashOld), JSON.stringify(r.details));
  for (const f of [newSnap, newVideo, newWork, result, input, shared, busyWork, cookies, ext, trashNew]) assert.ok(fs.existsSync(f), `fälschlich gelöscht: ${f}`);
  assert.ok(!fs.existsSync(path.join(root, 'projects/a/work/tmp')), 'leere Ordner entfernt');
  assert.ok(fs.existsSync(path.join(root, 'projects/a/work')), 'work/ selbst bleibt');
  assert.ok(r.freed > 2048);
  // a running browser's caches are never touched
  const cache2 = file('data/browsers/konto/Default/Cache/data_2', 1, 2048);
  ctx.browsers.running.set('konto', {});
  await new Janitor(ctx).run(now);
  assert.ok(fs.existsSync(cache2));
  assert.equal(trashTime('x-2026-11-22T17-28-05-369Z-files'), Date.parse('2026-11-22T17:28:05.369Z'));
});

test('Meta: Haiku names project and session, writes META.md, keeps a name the user set', async () => {
  const root = tmp('meta');
  const store = new Store(path.join(root, 'data'));
  await store.init();
  const projects = new Projects({ config: { projectsDir: path.join(root, 'projects'), templatesDir: path.join(root, 'tpl'), defaultModel: '', defaultMode: 'default', defaultEffort: '', browserMcp: true, permissionModes: ['default'], allowBypass: false }, store });
  const p = await projects.create({ name: 'Neues Projekt', git: false });
  const asked = [];
  let answer = '{"titel": "„LinkedIn-Profil für X“.", "beschreibung": "Überträgt Texte und Bilder vom LinkedIn-Profil auf X", "session": "Profilbild und Banner zuschneiden 🎨"}';
  const ctx = {
    store, projects, config: { claudeBin: '' }, sessions: { invalidate() {} }, runners: { peek: () => null },
    metaQuery: ({ prompt, options }) => { asked.push({ prompt, options }); return (async function* () { yield { type: 'result', result: answer }; })(); },
  };
  const meta = new Meta(ctx);
  const sid = '11111111-1111-4111-8111-111111111111';
  await store.writeStats(p.id, sid, { firstPrompt: 'x' });
  // prompts as the runner records them (onPrompt), then one naming pass without timers
  await store.writeJson(store.p('meta', `${p.id}.json`), { prompts: [{ sessionId: sid, text: 'Mach mein X wie mein LinkedIn', ts: Date.now() }], sessionCounts: { [sid]: 1 }, sessions: {} });
  const r = await meta.generate(p.id, sid);
  assert.equal(r.title, 'LinkedIn-Profil für X', 'Anführungszeichen und Punkt entfernt');
  assert.equal(r.session, 'Profilbild und Banner zuschneiden', 'Emoji entfernt');
  const after = await projects.get(p.id);
  assert.equal(after.name, 'LinkedIn-Profil für X');
  assert.equal(after.description, 'Überträgt Texte und Bilder vom LinkedIn-Profil auf X.');
  assert.equal((await store.readStats(p.id, sid)).title, 'Profilbild und Banner zuschneiden');
  const md = fs.readFileSync(path.join(after.dir, 'META.md'), 'utf8');
  assert.match(md, /^# LinkedIn-Profil für X\n\nÜberträgt Texte/);
  assert.match(md, /## Sessions\n\n- \d{4}-\d{2}-\d{2} Profilbild und Banner zuschneiden/);
  const opts = asked.at(-1).options;
  assert.deepEqual([opts.model, opts.maxTurns, opts.tools.length, opts.persistSession, opts.settingSources.length], ['haiku', 1, 0, false, 0]);
  assert.match(asked.at(-1).prompt, /Mach mein X wie mein LinkedIn/);
  // the user renamed it → Haiku may update the description but not the name
  await projects.update(p.id, { name: 'Mein Name', autoTitle: false });
  answer = '{"titel": "Etwas anderes", "beschreibung": "Neue Beschreibung", "session": "S"}';
  await meta.generate(p.id, sid);
  const final = await projects.get(p.id);
  assert.equal(final.name, 'Mein Name');
  assert.equal(final.description, 'Neue Beschreibung.');
});

test('charts: self-contained SVG page, palette order, legend/labels, limits, SQL mapping', () => {
  const html = renderChart({ title: 'Umsatz <Test>', type: 'bar', labels: ['Jan', 'Feb'], series: [{ name: 'Shop', values: [1200, 1500] }, { name: 'B2B', values: [300, null] }] });
  assert.match(html, /^<!doctype html>/);
  assert.ok(!/<script|https?:\/\/(?!www\.w3)/.test(html), 'no scripts, no external resources');
  assert.match(html, /Umsatz &lt;Test&gt;/, 'escaped');
  assert.match(html, /--s0:#2a78d6;--s1:#eb6834/, 'validated categorical order, light');
  assert.match(html, /--s0:#3987e5;--s1:#d95926/, 'selected dark steps');
  assert.match(html, /class="legend"/, 'legend for ≥ 2 series');
  assert.match(html, /<title>Shop · Feb: 1\.500<\/title>/, 'hover value, German number format');
  assert.match(html, /<summary>Tabelle<\/summary>/);
  const single = renderChart({ type: 'line', labels: ['a', 'b', 'c'], series: [{ name: 'Nur', values: [1, 2, 3] }] });
  assert.ok(!/class="legend"/.test(single), 'single series: no legend box');
  assert.throws(() => renderChart({ type: 'scatter', labels: ['1', '2'], series: [1, 2, 3, 4].map((i) => ({ name: `s${i}`, values: [1, 2] })) }), /höchstens 3 Reihen/);
  assert.throws(() => renderChart({ type: 'bar', labels: ['a'], series: [{ name: 'x', values: ['abc'] }] }), /keine Zahlen/);
  const spec = chartFromRows({ columns: ['monat', 'umsatz', 'kosten'], rows: [['Jan', 10, 4], ['Feb', 12, 5]] }, { x: 'monat', type: 'line', title: 't' });
  assert.deepEqual(spec.series.map((s) => s.name), ['umsatz', 'kosten']);
  assert.deepEqual(spec.labels, ['Jan', 'Feb']);
  assert.throws(() => chartFromRows({ columns: ['a'], rows: [] }, { x: 'b' }), /nicht im Ergebnis/);
});

test('AsyncQueue delivers in order and ends on close', async () => {
  const q = new AsyncQueue();
  q.push(1);
  q.push(2);
  setTimeout(() => { q.push(3); q.close(); }, 10);
  const got = [];
  for await (const x of q) got.push(x);
  assert.deepEqual(got, [1, 2, 3]);
});

test('UI and media are served from folders with a dot in the path (npx: ~/.npm/_npx, data: ~/.agentpit)', async () => {
  const express = (await import('express')).default;
  const { mountStatic } = await import('../server/static.js');
  const base = path.join(tmp('dots'), '.agentpit-test');
  const webDist = path.join(base, '.npm', '_npx', 'abc', 'node_modules', 'agentpit', 'web', 'dist');
  const mediaDir = path.join(base, '.agentpit', 'data', 'media');
  fs.mkdirSync(webDist, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>agentpit</title>');
  fs.writeFileSync(path.join(webDist, '.env'), 'SECRET=1');
  const media = `${'a'.repeat(24)}.png`;
  fs.writeFileSync(path.join(mediaDir, media), 'png');
  const app = express();
  app.use((req, _res, next) => { req.cockpitSession = { id: 'test' }; next(); }); // stands in for a valid session
  assert.equal(mountStatic(app, { webDist, mediaDir, hasUi: true }), true);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const root = await fetch(`${url}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /<title>agentpit<\/title>/);
    assert.equal((await fetch(`${url}/projekt/demo`)).status, 200); // SPA route
    const m = await fetch(`${url}/media/${media}`);
    assert.equal(m.status, 200);
    assert.equal(await m.text(), 'png');
    assert.equal((await fetch(`${url}/media/..%2F..%2Fx.png`)).status, 404);
    assert.doesNotMatch(await (await fetch(`${url}/.env`)).text(), /SECRET/); // real dotfiles stay hidden
  } finally {
    server.close();
  }
});

test('findBrowserExecutable finds Playwright Chromium in chrome-linux64, chrome-linux and chrome-linux-arm64', async () => {
  const { findBrowserExecutable, _test } = await import('../server/environment.js');
  const base = tmp('pw');
  const mk = (rev, sub, ...file) => { const f = path.join(base, `chromium-${rev}`, sub, ...file); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); fs.chmodSync(f, 0o755); return f; };
  const x64 = mk(1200, 'chrome-linux64', 'chrome');
  const old = mk(1201, 'chrome-linux', 'chrome');
  const arm = mk(1255, 'chrome-linux-arm64', 'chrome');
  const rev = (n) => path.join(base, `chromium-${n}`);
  assert.deepEqual(_test.chromiumCandidates(rev(1255), 'linux', 'arm64'), [arm]);
  assert.deepEqual(_test.chromiumCandidates(rev(1200), 'linux', 'x64'), [x64]);
  assert.deepEqual(_test.chromiumCandidates(rev(1201), 'linux', 'x64'), [old]);
  // both layouts in one revision: the CPU's own build first
  mk(1300, 'chrome-linux64', 'chrome');
  mk(1300, 'chrome-linux-arm64', 'chrome');
  assert.match(_test.chromiumCandidates(rev(1300), 'linux', 'arm64')[0], /chrome-linux-arm64/);
  assert.match(_test.chromiumCandidates(rev(1300), 'linux', 'x64')[0], /chrome-linux64/);
  assert.match(_test.chromiumCandidates(rev(1300), 'darwin', 'arm64')[0] ?? 'none', /none/); // no mac folders here
  // the real lookup on this machine, newest revision first
  const own = process.platform === 'win32' ? mk(1400, 'chrome-win64', 'chrome.exe')
    : process.platform === 'darwin' ? mk(1400, `chrome-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
      : mk(1400, process.arch === 'arm64' ? 'chrome-linux-arm64' : 'chrome-linux64', 'chrome');
  const saved = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = base;
  try { assert.equal(findBrowserExecutable('chromium'), own); } finally { process.env.PLAYWRIGHT_BROWSERS_PATH = saved; }
});

test('access: browser users get only their identities, admin everything', async () => {
  const { createAccess } = await import('../server/access.js');
  const users = { get: (n) => (n === 'anna' ? { name: 'anna', browsers: ['anna-b'] } : null) };
  const a = createAccess({ security: { users, adminName: () => 'admin' } });
  const admin = { user: null }, anna = { user: 'anna' };
  assert.doesNotThrow(() => a.check({ t: 'project.create' }, admin));
  assert.throws(() => a.check({ t: 'project.create' }, anna), /Kein Zugriff/);
  assert.throws(() => a.check({ t: 'term.open' }, anna), /Kein Zugriff/);
  assert.doesNotThrow(() => a.check({ t: 'browsers.input', id: 'anna-b' }, anna));
  assert.throws(() => a.check({ t: 'browsers.input', id: 'other' }, anna), /diesen Browser/);
  assert.equal(a.filter(anna, { t: 'projects', projects: [] }), null);
  assert.equal(a.filter(anna, { t: 'bframe', profileId: 'other' }), null);
  assert.ok(a.filter(anna, { t: 'bframe', profileId: 'anna-b' }));
  const list = a.filter(anna, { t: 'browsers', browsers: { profiles: [{ id: 'anna-b' }, { id: 'x' }], status: { path: '/secret' } } });
  assert.deepEqual(list.browsers.profiles.map((p) => p.id), ['anna-b']);
  assert.deepEqual(list.browsers.status, {});
  assert.equal(a.canUseBrowser({ user: 'anna' }, 'x'), false);
  assert.equal(a.canUseBrowser({ id: 's' }, 'x'), true);
});

test('login: admin and browser users, first setup from localhost without code, users fenced in', async () => {
  const express = (await import('express')).default;
  const { createSecurity } = await import('../server/security.js');
  const dataDir = tmp('sec');
  let sec;
  const app = express();
  app.set('query parser', 'simple');
  app.use((req, res, next) => sec.middleware(req, res, next));
  app.get(/.*/, (req, res) => res.json({ ok: true, user: req.cockpitSession.user ?? null }));
  app.post('/api/browsers/:id/upload', (_req, res) => res.json({ up: true }));
  app.post('/api/x', (_req, res) => res.json({ x: true }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  sec = createSecurity({ config: { dataDir, devOrigins: [], publicUrls: [] }, port });
  const base = `http://localhost:${port}`;
  const req = (p, opt = {}) => fetch(base + p, { redirect: 'manual', ...opt });
  const form = (o) => ({ method: 'POST', body: new URLSearchParams(o), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base } });
  const cookie = (r) => r.headers.get('set-cookie')?.split(';')[0];
  try {
    // first run, local: no setup code needed
    const setup = await req('/setup', form({ username: 'chef', password: 'geheim123', password2: 'geheim123' }));
    assert.equal(setup.status, 302);
    const adminC = cookie(setup);
    assert.ok(adminC);
    assert.equal(sec.adminName(), 'chef');
    assert.equal((await (await req('/', { headers: { cookie: adminC } })).json()).user, null);
    // through a tunnel the setup would have needed the code – and login with the wrong name fails
    assert.equal((await req('/login', form({ username: 'anna', password: 'geheim123' }))).status, 401);
    sec.users.create({ name: 'anna', password: 'annas-pw', browsers: ['anna-b'] }, ['chef']);
    const login = await req('/login', form({ username: 'anna', password: 'annas-pw' }));
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), '/u/anna/');
    const annaC = cookie(login);
    const home = await req('/', { headers: { cookie: annaC } });
    assert.equal(home.status, 302);
    assert.equal(home.headers.get('location'), '/u/anna/');
    assert.equal((await req('/u/chef/', { headers: { cookie: annaC } })).headers.get('location'), '/u/anna/');
    assert.equal((await (await req('/u/anna/', { headers: { cookie: annaC } })).json()).user, 'anna');
    assert.equal((await req('/api/projects', { headers: { cookie: annaC } })).status, 403);
    const post = (p, c) => req(p, { method: 'POST', headers: { cookie: c, origin: base, 'x-cockpit': '1', 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await post('/api/x', annaC)).status, 403);
    assert.equal((await post('/api/browsers/anna-b/upload', annaC)).status, 200);
    assert.equal((await post('/api/x', adminC)).status, 200);
    // new password from the admin ends anna's sessions, admin stays signed in
    sec.users.setPassword('anna', 'neu-pw-123');
    assert.equal((await req('/u/anna/', { headers: { cookie: annaC } })).status, 401);
    assert.equal((await req('/', { headers: { cookie: adminC } })).status, 200);
  } finally { server.close(); sec.flush(); }
});

test('audio: fMP4 stream splits into init segment and fragments', async () => {
  const { _test } = await import('../server/audio.js');
  const box = (type, len = 16) => { const b = Buffer.alloc(len); b.writeUInt32BE(len, 0); b.write(type, 4, 'latin1'); return b; };
  const inits = [], frags = [];
  const s = new _test.Fmp4Splitter((i) => inits.push(i), (f) => frags.push(f));
  const stream = Buffer.concat([box('ftyp', 20), box('moov', 40), box('moof', 24), box('mdat', 100), box('moof', 24), box('mdat', 50)]);
  for (let i = 0; i < stream.length; i += 7) s.push(stream.subarray(i, i + 7)); // arbitrary chunking
  assert.equal(inits.length, 1);
  assert.equal(inits[0].length, 60);
  assert.deepEqual(frags.map((f) => f.length), [124, 74]);
});
