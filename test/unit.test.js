import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Files } from '../server/files.js';
import { Limits } from '../server/limits.js';
import { Media } from '../server/media.js';
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

test('AsyncQueue delivers in order and ends on close', async () => {
  const q = new AsyncQueue();
  q.push(1);
  q.push(2);
  setTimeout(() => { q.push(3); q.close(); }, 10);
  const got = [];
  for await (const x of q) got.push(x);
  assert.deepEqual(got, [1, 2, 3]);
});
