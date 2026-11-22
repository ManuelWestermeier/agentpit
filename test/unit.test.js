import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Files } from '../server/files.js';
import { Limits } from '../server/limits.js';
import { Media } from '../server/media.js';
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

test('AsyncQueue delivers in order and ends on close', async () => {
  const q = new AsyncQueue();
  q.push(1);
  q.push(2);
  setTimeout(() => { q.push(3); q.close(); }, 10);
  const got = [];
  for await (const x of q) got.push(x);
  assert.deepEqual(got, [1, 2, 3]);
});
