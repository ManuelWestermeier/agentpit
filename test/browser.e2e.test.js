// Browser end-to-end test with a real Chrome/Edge/Chromium – runs on Windows, macOS and Linux.
//   npm run test:browser
//   E2E_ENGINE=chrome|msedge|chromium   (default: first one found)
//   E2E_MODES=headless,headed           (default: headless, plus headed when a screen exists)
// Linux without a screen: xvfb-run -a npm run test:browser
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Browsers } from '../server/browsers.js';
import { findBrowserExecutable } from '../server/environment.js';
import { Store } from '../server/store.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, 'browsers');

const engine = process.env.E2E_ENGINE || ['chrome', 'msedge', 'chromium'].find((e) => findBrowserExecutable(e));
const screen = process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const modes = (process.env.E2E_MODES || (screen ? 'headless,headed' : 'headless')).split(',').map((s) => s.trim()).filter(Boolean);
const skip = !engine || !findBrowserExecutable(engine) ? `kein Browser gefunden (${engine ?? 'chrome/msedge/chromium'})` : false;

const PAGE = '<!doctype html><title>e2e</title><div id="d" style="font:40px monospace"></div>'
  + '<script>const d=document.getElementById("d");const t=()=>{d.textContent=performance.now().toFixed(1);requestAnimationFrame(t)};t()</script>';

const waitFor = async (pred, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Zeitüberschreitung: ${what}`);
};

for (const mode of modes) {
  describe(`Browser ${engine} (${mode}) auf ${process.platform}-${process.arch}`, { skip, concurrency: false }, () => {
    let b, e, id, url, server, dir, mainPage;
    const stats = [];
    let frames = 0;
    let lastAcceptLanguage = '';
    const viewer = { ws: { bufferedAmount: 0, readyState: 1 } };

    before(async () => {
      server = http.createServer((req, res) => {
        lastAcceptLanguage = req.headers['accept-language'] ?? '';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r)); // 127.0.0.1 = secure context, no firewall prompt
      url = `http://127.0.0.1:${server.address().port}/`;
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-'));
      const store = new Store(dir);
      await store.init();
      const ctx = {
        store, root: ROOT, config: { maxBrowsers: 2, trashDir: path.join(dir, 'trash') }, env: { browser: {} }, projects: { list: async () => [] },
        hub: { send: (c, m) => { if (m.t === 'bframe') frames++; else if (m.t === 'bstats') stats.push(m); }, toAll: () => {} },
      };
      b = new Browsers(ctx);
      await b.init();
      const p = await b.create({ name: `e2e-${mode}`, engine, headless: mode === 'headless', temporary: true, lang: 'de-DE', timezone: 'America/New_York', colorScheme: 'dark' });
      id = p.id;
      await b.view(id, viewer, true);
      e = b.running.get(id);
      mainPage = e.active;
      // Extensions installed on the machine (e.g. a login page) may open tabs in a fresh profile – keep the test page in view.
      e.context.on('page', (pg) => setTimeout(async () => {
        await pg.close().catch(() => {});
        const i = e.context.pages().indexOf(mainPage);
        if (i >= 0) await b.tab(id, { op: 'select', index: i }).catch(() => {});
      }, 200));
      await b.navigate(id, { action: 'go', url });
      await waitFor(() => mainPage.evaluate(() => !!document.getElementById('d')).catch(() => false), 15_000, 'Testseite geladen');
    });

    after(async () => {
      await b?.stopAll();
      server?.close();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* browser may still hold files on Windows */ }
    });

    test('Identität: Sprache, Zeitzone, Farbschema, kein Automations-/Headless-Merkmal', { timeout: 30_000 }, async () => {
      const r = await mainPage.evaluate(async () => ({
        ua: navigator.userAgent, webdriver: navigator.webdriver, langs: navigator.languages, platform: navigator.platform,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone, dark: matchMedia('(prefers-color-scheme: dark)').matches,
        brands: navigator.userAgentData?.brands?.map((x) => x.brand) ?? null,
      }));
      assert.equal(r.webdriver, false);
      assert.doesNotMatch(r.ua, /Headless/i);
      if (r.brands) assert.ok(!r.brands.some((x) => /Headless/i.test(x)), `brands: ${r.brands}`);
      assert.equal(r.langs[0], 'de-DE');
      assert.match(lastAcceptLanguage, /^de-DE/);
      assert.equal(r.tz, 'America/New_York');
      assert.equal(r.dark, true);
      const expected = process.platform === 'win32' ? /^Win32$/ : process.platform === 'darwin' ? /^MacIntel$/ : /^Linux /;
      assert.match(r.platform, expected);
    });

    test('Stream liefert Bilder und Messwerte', { timeout: 30_000 }, async () => {
      frames = 0;
      await waitFor(() => frames >= 5, 15_000, '5 Bilder');
      await waitFor(() => stats.some((s) => s.fps > 0 && s.kbps > 0), 10_000, 'Stream-Statistik');
    });

    test('Auto-Modus regelt bei überlasteter Leitung herunter und danach wieder hoch', { timeout: 60_000 }, async () => {
      const start = e.level;
      viewer.ws.bufferedAmount = 64 * 1024 * 1024; // simulated slow connection
      await waitFor(() => e.level >= Math.min(start + 2, 6), 20_000, 'Herunterregeln');
      const low = e.level;
      viewer.ws.bufferedAmount = 0;
      await waitFor(() => e.level < low, 25_000, 'Hochregeln');
    });

    test('Manuell: Bildraten-Limit wird eingehalten, Format JPEG', { timeout: 30_000 }, async () => {
      await b.setStream(id, { mode: 'manual', quality: 40, maxWidth: 800, fps: 5, format: 'jpeg' });
      await new Promise((r) => setTimeout(r, 1000));
      frames = 0;
      await new Promise((r) => setTimeout(r, 3000));
      assert.ok(frames <= 5 * 3 + 3, `zu viele Bilder: ${frames} in 3 s bei 5 fps`);
      assert.ok(frames >= 2, `zu wenige Bilder: ${frames} in 3 s`);
      assert.equal(e.streamFormat, 'jpeg');
    });

    test('Farbschema lässt sich live ändern, ohne Neustart', { timeout: 15_000 }, async () => {
      const r = await b.update(id, { colorScheme: 'light' });
      assert.equal(r.restartNeeded, false);
      await waitFor(() => mainPage.evaluate(() => !matchMedia('(prefers-color-scheme: dark)').matches), 5000, 'helles Schema');
    });
  });
}
