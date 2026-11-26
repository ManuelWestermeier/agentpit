// Media bridge end-to-end with a real, visible browser: sound out, microphone and camera in,
// <select> on the viewer's side, files dropped from outside, drag & drop inside the page.
//   npm run test:browser
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../server/bridge.js';
import { Browsers } from '../server/browsers.js';
import { Cdp } from '../server/cdp.js';
import { findBrowserExecutable } from '../server/environment.js';
import { Store } from '../server/store.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, 'browsers');
const engine = process.env.E2E_ENGINE || ['chrome', 'msedge', 'chromium'].find((e) => findBrowserExecutable(e));
const screen = process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const skip = !engine ? 'kein Browser' : !screen ? 'braucht einen Bildschirm (xvfb-run)' : false;

const PAGE = `<!doctype html><title>bridge</title>
<select id="s" style="position:fixed;left:10px;top:10px;width:200px;height:30px"><option>eins</option><option>zwei</option><option>drei</option></select>
<div id="drop" style="position:fixed;left:10px;top:60px;width:300px;height:120px;background:#ddd">drop</div>
<div id="drag" draggable="true" style="position:fixed;left:10px;top:200px;width:80px;height:40px;background:#f80">drag</div>
<div id="target" style="position:fixed;left:300px;top:200px;width:120px;height:80px;background:#08f">target</div>
<script>
window.log = [];
const s = document.getElementById('s'); s.addEventListener('change', () => log.push('change:' + s.value));
const d = document.getElementById('drop');
d.addEventListener('dragover', (e) => e.preventDefault());
d.addEventListener('drop', (e) => { e.preventDefault(); log.push('files:' + [...e.dataTransfer.files].map((f) => f.name).join(',')); });
document.getElementById('drag').addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'paket'));
const t = document.getElementById('target');
t.addEventListener('dragover', (e) => e.preventDefault());
t.addEventListener('drop', (e) => { e.preventDefault(); log.push('dropped:' + e.dataTransfer.getData('text/plain')); });
</script>`;

const waitFor = async (pred, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`Zeitüberschreitung: ${what}`);
};

describe(`Medien-Brücke (${engine}, sichtbar)`, { skip, concurrency: false }, () => {
  let b, bridge, e, id, server, dir, tab;
  const msgs = [];
  const viewer = { ws: { bufferedAmount: 0, readyState: 1 } };
  const page = async (expr, gesture = false) => {
    const v = await fetch(`http://127.0.0.1:${e.port}/json/version`).then((r) => r.json());
    const c = await Cdp.connect(v.webSocketDebuggerUrl);
    try {
      const sid = await c.attach(tab);
      const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: gesture }, sid);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    } finally { c.close(); }
  };
  const click = async (x, y) => {
    b.input(id, { kind: 'mouse', type: 'down', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await b.input(id, { kind: 'mouse', type: 'up', x, y, button: 'left', clickCount: 1 });
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-bridge-'));
    server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const store = new Store(dir);
    await store.init();
    const ctx = {
      store, root: ROOT, config: { maxBrowsers: 2, trashDir: path.join(dir, 'trash'), dataDir: dir, port: server.address().port }, env: { browser: {} }, projects: { list: async () => [] },
      hub: { send: (_c, m) => { if (m.t !== 'bframe' && m.t !== 'bstats') msgs.push(m); }, toAll: () => {} },
    };
    ctx.bridge = bridge = new Bridge(ctx);
    server.on('upgrade', (req, socket, head) => bridge.handleUpgrade(req, socket, head));
    ctx.browsers = b = new Browsers(ctx);
    await b.init();
    id = (await b.create({ name: 'bridge', engine, headless: false, temporary: true })).id;
    await b.view(id, viewer, true);
    e = b.running.get(id);
    await b.navigate(id, { action: 'go', url: `http://127.0.0.1:${server.address().port}/` });
    tab = e.active;
    await waitFor(() => page('!!document.getElementById("s")').catch(() => false), 15_000, 'Testseite');
  });

  after(async () => {
    await b?.stopAll();
    server?.closeAllConnections?.();
    server?.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows locks */ }
  });

  test('Erweiterung verbindet sich mit dem Cockpit', { timeout: 20_000 }, async () => {
    await waitFor(() => bridge.connected(id), 15_000, 'Service Worker verbunden'); // the offscreen document only starts with the first sound request
  });

  test('getUserMedia sieht für die Seite eingebaut aus', { timeout: 10_000 }, async () => {
    const r = await page(`({ s: MediaDevices.prototype.getUserMedia.toString(), t: Function.prototype.toString.toString(), n: MediaDevices.prototype.getUserMedia.name, l: MediaDevices.prototype.getUserMedia.length })`);
    assert.equal(r.s, 'function getUserMedia() { [native code] }');
    assert.equal(r.t, 'function toString() { [native code] }');
    assert.equal(r.n, 'getUserMedia');
    assert.equal(r.l, 0);
  });

  test('Mikrofon des Zuschauers kommt in der Seite an', { timeout: 20_000 }, async () => {
    bridge.device(id, viewer, 'mic', true);
    await new Promise((r) => setTimeout(r, 300));
    const pcm = Buffer.alloc(24000 * 2 * 0.1); // 100 ms 440 Hz
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin((i / 24000) * 2 * Math.PI * 440) * 12000), i * 2);
    const feed = setInterval(() => bridge.data(id, viewer, 1, pcm), 100);
    try {
      const level = await page(`navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => new Promise((res) => {
        const ctx = new AudioContext(); const a = ctx.createAnalyser(); ctx.createMediaStreamSource(s).connect(a); ctx.resume();
        const buf = new Float32Array(a.fftSize); let max = 0, n = 0;
        const t = setInterval(() => { a.getFloatTimeDomainData(buf); for (const v of buf) max = Math.max(max, Math.abs(v)); if (++n > 30) { clearInterval(t); res({ max, label: s.getAudioTracks()[0].label }); } }, 50);
      }))`, true);
      assert.ok(level.max > 0.1, `Pegel ${level.max}`);
      const devices = await page('navigator.mediaDevices.enumerateDevices().then((l) => l.map((d) => d.kind + ":" + d.label))');
      assert.ok(devices.includes('audioinput:Mikrofon'), devices.join(', '));
    } finally { clearInterval(feed); bridge.device(id, viewer, 'mic', false); }
  });

  test('Kamera des Zuschauers kommt in der Seite an', { timeout: 20_000 }, async () => {
    bridge.device(id, viewer, 'cam', true);
    await new Promise((r) => setTimeout(r, 300));
    // a red 64×48 JPEG from the browser itself
    const jpeg = Buffer.from(await page(`(() => { const c = document.createElement('canvas'); c.width = 64; c.height = 48; const g = c.getContext('2d'); g.fillStyle = 'rgb(250,0,0)'; g.fillRect(0, 0, 64, 48); return c.toDataURL('image/jpeg').split(',')[1]; })()`), 'base64');
    const feed = setInterval(() => bridge.data(id, viewer, 2, jpeg), 80);
    try {
      const px = await page(`navigator.mediaDevices.getUserMedia({ video: true }).then((s) => new Promise((res) => {
        const v = document.createElement('video'); v.muted = true; v.srcObject = s; v.play();
        setTimeout(() => { const c = document.createElement('canvas'); c.width = 64; c.height = 48; const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 48); res([...g.getImageData(32, 24, 1, 1).data]); }, 1500);
      }))`, true);
      assert.ok(px[0] > 180 && px[1] < 80, `Pixel ${px}`);
    } finally { clearInterval(feed); bridge.device(id, viewer, 'cam', false); }
  });

  test('Ton der Seite wird zum Zuschauer übertragen', { timeout: 30_000 }, async () => {
    await page(`(() => { const c = new AudioContext(); const o = c.createOscillator(); o.connect(c.destination); o.start(); c.resume(); window.osc = o; return true; })()`, true);
    msgs.length = 0;
    bridge.listen(id, viewer, true);
    try {
      await waitFor(() => msgs.some((m) => m.t === 'bmedia' && m.init), 10_000, 'WebM-Kopf');
      await waitFor(() => msgs.filter((m) => m.t === 'bmedia' && m.data).length >= 5, 10_000, 'Tondaten');
      const head = Buffer.from(msgs.find((m) => m.init).init, 'base64');
      assert.equal(head.readUInt32BE(0), 0x1a45dfa3, 'EBML-Kopf');
    } finally { bridge.listen(id, viewer, false); await page('window.osc.stop(), true'); }
  });

  test('Safari/iPhone: derselbe Ton als AAC in MP4 (ffmpeg auf dem Server)', { timeout: 30_000 }, async () => {
    await page(`(() => { const c = new AudioContext(); const o = c.createOscillator(); o.connect(c.destination); o.start(); c.resume(); window.osc = o; return true; })()`, true);
    msgs.length = 0;
    const safari = { ws: { bufferedAmount: 0, readyState: 1 } };
    bridge.listen(id, safari, true, 'mp4');
    try {
      const init = await waitFor(() => msgs.find((m) => m.t === 'bmedia' && m.codec === 'mp4' && m.init), 15_000, 'MP4-Kopf');
      assert.equal(Buffer.from(init.init, 'base64').toString('latin1', 4, 8), 'ftyp');
      await waitFor(() => msgs.filter((m) => m.t === 'bmedia' && m.codec === 'mp4' && m.data).length >= 5, 15_000, 'AAC-Fragmente');
      assert.ok(!msgs.some((m) => m.t === 'bmedia' && m.codec === 'webm'), 'kein WebM an Safari');
    } finally { bridge.listen(id, safari, false); await page('window.osc.stop(), true'); }
  });

  test('Ton einschalten, bevor die Brücke verbunden ist, wartet statt zu scheitern', { timeout: 10_000 }, async () => {
    const e2 = bridge.ids.get(id);
    const sw = e2.sw;
    e2.sw = null; // as if the extension had not connected yet
    const late = { ws: { bufferedAmount: 0, readyState: 1 } };
    try {
      const r = bridge.listen(id, late, true);
      assert.equal(r.connected, false);
      assert.ok(e2.listeners.has(late));
    } finally { bridge.listen(id, late, false); e2.sw = sw; }
  });

  test('Auswahlliste (<select>) öffnet sich beim Zuschauer', { timeout: 20_000 }, async () => {
    msgs.length = 0;
    await click(100, 25);
    const m = await waitFor(() => msgs.find((x) => x.t === 'bselect'), 5000, 'bselect');
    assert.deepEqual(m.options.map((o) => o.label), ['eins', 'zwei', 'drei']);
    bridge.choose(id, m.sel, 2);
    await waitFor(async () => (await page('log.join("|")')).includes('change:drei'), 5000, 'Auswahl übernommen');
  });

  test('Dateien von außen in die Seite ziehen', { timeout: 20_000 }, async () => {
    const up = await b.uploadPath(id, 'bild.png');
    fs.writeFileSync(up.abs, 'x');
    await b.dropFiles(id, { x: 100, y: 100, files: [up.file] });
    await waitFor(async () => (await page('log.join("|")')).includes('files:') , 5000, 'drop');
    assert.match(await page('log.join("|")'), /files:\w+-bild\.png/);
  });

  test('Tipp ohne vorherige Mausbewegung (Handy) kommt an', { timeout: 10_000 }, async () => {
    await page('window.taps = 0; document.getElementById("target").onclick = () => taps++, true');
    await click(360, 240);
    await waitFor(async () => (await page('taps')) === 1, 3000, 'Klick').catch(async (x) => { throw new Error(x.message + ' taps=' + await page('taps')); });
  });

  test('Drag & Drop innerhalb der Seite', { timeout: 20_000 }, async () => {
    await b.input(id, { kind: 'mouse', type: 'down', x: 40, y: 220, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 10; i++) { b.input(id, { kind: 'mouse', type: 'move', x: 40 + i * 32, y: 220 + i * 2, button: 'left', buttons: 1 }); await new Promise((r) => setTimeout(r, 40)); }
    await new Promise((r) => setTimeout(r, 200));
    await b.input(id, { kind: 'mouse', type: 'up', x: 360, y: 240, button: 'left', clickCount: 1 });
    await waitFor(async () => (await page('log.join("|")')).includes('dropped:paket'), 5000, 'drop im Ziel');
  });
});
