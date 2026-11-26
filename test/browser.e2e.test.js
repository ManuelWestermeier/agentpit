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
import { Cdp } from '../server/cdp.js';
import { findBrowserExecutable } from '../server/environment.js';
import { Store } from '../server/store.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, 'browsers');

const engine = process.env.E2E_ENGINE || ['chrome', 'msedge', 'chromium'].find((e) => findBrowserExecutable(e));
const screen = process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const modes = (process.env.E2E_MODES || (screen ? 'headless,headed' : 'headless')).split(',').map((s) => s.trim()).filter(Boolean);
const skip = !engine || !findBrowserExecutable(engine) ? `kein Browser gefunden (${engine ?? 'chrome/msedge/chromium'})` : false;

// The page also runs the usual CDP check of anti-bot scripts: with Runtime enabled anywhere, console
// arguments get serialised and the stack getter fires. A regular browser never does that.
const PAGE = '<!doctype html><title>e2e</title><div id="d" style="font:40px monospace"></div>'
  + '<input type="file" id="f" style="position:fixed;left:0;top:200px;width:300px;height:60px"><button id="b" style="position:fixed;left:0;top:300px;width:300px;height:60px" onclick="window.clicks=(window.clicks||0)+1">x</button>'
  + '<script>const d=document.getElementById("d");const t=()=>{d.textContent=performance.now().toFixed(1);requestAnimationFrame(t)};t();'
  + 'window.cdpSeen=false;setInterval(()=>{const e=new Error();Object.defineProperty(e,"stack",{get(){window.cdpSeen=true;return""}});console.debug(e)},100)</script>';

/** Evaluates in the page from a separate test connection (Runtime.evaluate needs no Runtime.enable). */
async function evalIn(port, targetId, fn) {
  const v = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const c = await Cdp.connect(v.webSocketDebuggerUrl);
  try {
    const sid = await c.attach(targetId);
    const r = await c.send('Runtime.evaluate', { expression: `(${fn})()`, returnByValue: true, awaitPromise: true }, sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  } finally { c.close(); }
}

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
    const messages = [];
    const page = (fn) => evalIn(e.port, mainPage, fn);
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
        hub: { send: (c, m) => { if (m.t === 'bframe') { frames++; c.onFrame?.(m); } else if (m.t === 'bstats') stats.push(m); else messages.push(m); }, toAll: () => {} },
      };
      b = new Browsers(ctx);
      await b.init();
      const p = await b.create({ name: `e2e-${mode}`, engine, headless: mode === 'headless', temporary: true, lang: 'de-DE', timezone: 'America/New_York', colorScheme: 'dark' });
      id = p.id;
      await b.view(id, viewer, true);
      e = b.running.get(id);
      mainPage = e.active;
      // Extensions installed on the machine (e.g. a login page) may open tabs in a fresh profile – keep the test page in view.
      e.cdp.on('Target.targetCreated', ({ targetInfo: t }) => {
        if (t.type !== 'page' || t.targetId === mainPage || e.ownTabs?.has(t.targetId)) return;
        setTimeout(async () => {
          await e.cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
          const i = [...e.pages.keys()].indexOf(mainPage);
          if (i >= 0) await b.tab(id, { op: 'select', index: i }).catch(() => {});
        }, 200);
      });
      await b.navigate(id, { action: 'go', url });
      await waitFor(() => page(() => !!document.getElementById('d')).catch(() => false), 15_000, 'Testseite geladen');
    });

    after(async () => {
      await b?.stopAll();
      server?.closeAllConnections?.();
      server?.close();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* browser may still hold files on Windows */ }
    });

    test('Identität: Sprache, Zeitzone, Farbschema, kein Automations-/Headless-Merkmal', { timeout: 30_000 }, async () => {
      const r = await page(() => ({
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

    test('Tunnel-Szenario: Stau hinter dem Server wird über Bild-Bestätigungen erkannt, Latenz bleibt begrenzt', { timeout: 60_000 }, async () => {
      // The local socket stays empty (bufferedAmount 0, like a tunnel client on the same machine),
      // the path behind it carries only ~5 frames/s of the best quality, 40 ms base latency. Without
      // end-to-end flow control frames would queue there and the delay would grow without bound.
      e.level = 0;
      await b.setStream(id, { mode: 'auto' }); // fresh screencast at best quality
      frames = 0;
      await waitFor(() => frames >= 3 && e.lastFrame, 10_000, 'Bilder in bester Qualität');
      const BPS = e.lastFrame.data.length * 8 * 5, BASE = 40;
      let linkFree = 0, maxInflight = 0;
      const delays = [];
      viewer.ws.bufferedAmount = 0;
      const txTimes = []; // transmission time of each frame on the simulated link
      viewer.onFrame = (m) => {
        const now = Date.now();
        const tx = (m.data.length * 8 / BPS) * 1000;
        txTimes.push({ at: now, tx });
        linkFree = Math.max(now, linkFree) + tx;
        const arrive = linkFree + BASE;
        setTimeout(() => { delays.push({ at: Date.now(), d: Date.now() - now }); b.frameAck(id, viewer, m.seq); }, arrive - now);
      };
      const watch = setInterval(() => { maxInflight = Math.max(maxInflight, e.vs.get(viewer)?.inflight.length ?? 0); }, 20);
      try {
        await waitFor(() => e.level >= 2, 30_000, 'Herunterregeln über Bestätigungen');
        await new Promise((r) => setTimeout(r, 4000));
        const recent = delays.filter((x) => x.at > Date.now() - 3000).map((x) => x.d);
        assert.ok(recent.length > 0, 'keine angezeigten Bilder');
        const worst = Math.max(...recent);
        // bounded: base latency + at most 3 frames on the wire (+ scheduling slack) – it must not keep growing
        const maxTx = Math.max(...txTimes.filter((x) => x.at > Date.now() - 4500).map((x) => x.tx));
        // + slack for timer jitter on a loaded machine; without flow control this would be many seconds and growing
        const bound = BASE + 3 * maxTx + 1000;
        assert.ok(worst < bound, `Latenz läuft weg: ${worst} ms (Grenze ${Math.round(bound)} ms)`);
        assert.ok(maxInflight <= 3, `zu viele unbestätigte Bilder unterwegs: ${maxInflight}`);
        const s = stats.filter((x) => x.rtt != null).at(-1); // messages right after a level change carry no measurement
        assert.ok(s && s.rtt >= BASE, `Latenz-Messung fehlt: ${JSON.stringify(stats.at(-1))}`);
      } finally {
        clearInterval(watch);
        viewer.onFrame = (m) => setImmediate(() => b.frameAck(id, viewer, m.seq)); // fast local viewer from now on
      }
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
      await waitFor(() => page(() => !matchMedia('(prefers-color-scheme: dark)').matches), 5000, 'helles Schema');
    });

    test('Kein Konsolen-Merkmal: das Cockpit schaltet Runtime nie ein', { timeout: 15_000 }, async () => {
      await new Promise((r) => setTimeout(r, 1500)); // the page checks every 100 ms
      assert.equal(await page(() => window.cdpSeen), false);
    });

    test('Klicks kommen an, auch nach einem Tab-Wechsel', { timeout: 30_000 }, async () => {
      const click = async () => {
        b.input(id, { kind: 'mouse', type: 'down', x: 100, y: 330, button: 'left', buttons: 1, clickCount: 1 });
        await b.input(id, { kind: 'mouse', type: 'up', x: 100, y: 330, button: 'left', clickCount: 1 });
      };
      const before = await page(() => window.clicks || 0);
      await click();
      await waitFor(async () => (await page(() => window.clicks || 0)) > before, 5000, 'Klick');
      (e.ownTabs ??= new Set());
      const n = e.pages.size;
      await b.tab(id, { op: 'new' });
      e.ownTabs.add(e.active);
      assert.equal(e.pages.size, n + 1);
      await b.tab(id, { op: 'close', index: [...e.pages.keys()].indexOf(e.active) });
      await waitFor(() => e.active === mainPage, 5000, 'zurück zum Test-Tab');
      const mid = await page(() => window.clicks);
      await click();
      await waitFor(async () => (await page(() => window.clicks)) > mid, 5000, 'Klick nach Tab-Wechsel');
    });

    test('Seiten-Dialog erscheint beim Zuschauer und lässt sich beantworten', { timeout: 20_000 }, async () => {
      messages.length = 0;
      const res = page(() => new Promise((r) => setTimeout(() => r(confirm('Weiter?')), 50)));
      await waitFor(() => messages.find((m) => m.t === 'bdialog' && m.type === 'confirm'), 5000, 'Dialog-Nachricht');
      await b.answerDialog(id, true);
      assert.equal(await res, true);
    });

    test('Datei-Auswahl: der Zuschauer liefert die Datei statt eines unsichtbaren OS-Dialogs', { timeout: 20_000 }, async () => {
      messages.length = 0;
      b.input(id, { kind: 'mouse', type: 'down', x: 100, y: 230, button: 'left', buttons: 1, clickCount: 1 });
      await b.input(id, { kind: 'mouse', type: 'up', x: 100, y: 230, button: 'left', clickCount: 1 });
      await waitFor(() => messages.find((m) => m.t === 'bfile'), 5000, 'Datei-Dialog-Nachricht');
      const up = await b.uploadPath(id, 'notiz.txt');
      fs.writeFileSync(up.abs, 'hallo');
      await b.chooseFiles(id, [up.file]);
      await waitFor(async () => (await page(() => document.getElementById('f').files[0]?.name ?? '')).endsWith('notiz.txt'), 5000, 'Datei im Formular');
    });
  });
}
