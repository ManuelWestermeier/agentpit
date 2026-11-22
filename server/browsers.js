import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowserExecutable } from './environment.js';
import { UserError, slugify, stripAnsi, throttle, withTimeout } from './util.js';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENGINES = ['chromium', 'chrome', 'msedge'];
const BASE_PORT = 9230;
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

function onPath(bin) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const f = path.join(dir, bin);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
  }
  return null;
}

/** Major version of a Chromium-based browser without starting it. */
function browserMajor(exe) {
  try {
    const dir = path.dirname(exe);
    const hit = fs.readdirSync(dir).map((n) => /^(\d+)\.\d+\.\d+\.\d+/.exec(n)).find(Boolean); // Windows: version folder / manifest
    if (hit) return hit[1];
  } catch { /* fall through */ }
  if (process.platform === 'win32') return null;
  try { return /(\d+)\.\d+\.\d+/.exec(execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 8000 }))?.[1] ?? null; } catch { return null; }
}

/** User agent of the headed browser – headless Chromium announces "HeadlessChrome", which many logins (Google) reject. */
function headedUserAgent(exe, engine) {
  const major = browserMajor(exe);
  if (!major) return null;
  const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${engine === 'msedge' ? ` Edg/${major}.0.0.0` : ''}`;
}

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

async function waitForCdp(port, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new UserError('Browser antwortet nicht auf dem Debug-Port');
}

const num = (v, lo, hi, d = 0) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

/**
 * Browser identities: each profile is its own user-data-dir (cookies, localStorage, IndexedDB,
 * logins fully separate). A running profile is a normal Chromium/Chrome/Edge process with a
 * DevTools port on 127.0.0.1 – no automation flags, so sites see a regular browser.
 * The cockpit streams it (CDP screencast) and forwards mouse/keyboard; Claude sessions linked to
 * the profile drive the very same browser through Playwright MCP (--cdp-endpoint).
 */
export class Browsers extends EventEmitter {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.file = ctx.store.p('browsers.json');
    this.profiles = new Map();
    this.running = new Map();
    this.install = { state: 'idle', lines: [] };
    this.emitList = throttle(() => this.ctx.hub.toAll({ t: 'browsers', browsers: { profiles: this.list(), status: this.status() } }), 250);
  }

  dir(id) { return this.ctx.store.p('browsers', id); }

  async init() {
    const saved = await this.ctx.store.readJson(this.file, []);
    for (const p of Array.isArray(saved) ? saved : []) if (ID_RE.test(p.id)) this.profiles.set(p.id, p);
    if (!this.profiles.size) await this.create({ name: 'Haupt-Identität' });
  }

  #save() { return this.ctx.store.writeJson(this.file, [...this.profiles.values()]); }

  list() {
    return [...this.profiles.values()].map((p) => {
      const r = this.running.get(p.id);
      return { ...p, running: !!r, starting: !!r?.starting, port: r?.port ?? p.port ?? null, viewers: r?.viewers.size ?? 0, url: r?.state?.url ?? null, title: r?.state?.title ?? null };
    });
  }

  get(id) {
    const p = this.profiles.get(id);
    if (!p) throw new UserError('Browser-Profil existiert nicht');
    return p;
  }

  #clean(input = {}, base = {}) {
    const out = { ...base };
    if (typeof input.name === 'string' && input.name.trim()) out.name = input.name.trim().slice(0, 60);
    if (ENGINES.includes(input.engine)) out.engine = input.engine;
    if (typeof input.headless === 'boolean') out.headless = input.headless;
    if (typeof input.temporary === 'boolean') out.temporary = input.temporary;
    if (typeof input.proxy === 'string') {
      const proxy = input.proxy.trim();
      if (proxy && !/^(https?|socks5?):\/\/[^\s"]+$/i.test(proxy)) throw new UserError('Proxy im Format http://host:port oder socks5://host:port');
      out.proxy = proxy;
    }
    if (typeof input.lang === 'string') out.lang = /^[a-z]{2}(-[A-Z]{2})?$/.test(input.lang.trim()) ? input.lang.trim() : '';
    if (typeof input.startUrl === 'string') out.startUrl = input.startUrl.trim().slice(0, 500);
    if (typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color)) out.color = input.color;
    return out;
  }

  async create(input) {
    const base = slugify(input.name || 'profil');
    let id = base;
    for (let i = 2; this.profiles.has(id); i++) id = `${base}-${i}`;
    const used = new Set([...this.profiles.values()].map((p) => p.port));
    let port = BASE_PORT;
    while (used.has(port)) port++;
    const p = this.#clean(input, {
      id, name: id, engine: this.defaultEngine(), headless: this.defaultHeadless(), temporary: false, proxy: '', lang: 'de-DE', startUrl: '', color: '#8bb6db', port, createdAt: Date.now(),
    });
    this.profiles.set(id, p);
    await this.#save();
    this.emitList();
    return p;
  }

  async update(id, patch) {
    const p = this.get(id);
    const next = this.#clean(patch, p);
    this.profiles.set(id, next);
    await this.#save();
    this.emitList();
    return { ...next, restartNeeded: this.running.has(id) };
  }

  async remove(id) {
    this.get(id);
    await this.stop(id);
    const src = this.dir(id);
    if (fs.existsSync(src)) {
      const target = path.join(this.ctx.config.trashDir, `browser-${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      await fsp.mkdir(this.ctx.config.trashDir, { recursive: true });
      await fsp.rename(src, target).catch(() => fsp.rm(src, { recursive: true, force: true }));
    }
    this.profiles.delete(id);
    await this.#save();
    for (const pr of await this.ctx.projects.list()) {
      if (pr.browserProfile === id) await this.ctx.projects.update(pr.id, { browserProfile: '' });
    }
    this.emitList();
  }

  defaultEngine() {
    const b = this.ctx.env?.browser;
    if (b?.chrome) return 'chrome';
    if (findBrowserExecutable('chromium')) return 'chromium';
    if (b?.msedge) return 'msedge';
    return 'chromium';
  }

  // ------------------------------------------------------------------ lifecycle

  async ensureRunning(id) {
    const r = this.running.get(id);
    if (r?.ready) return r.port;
    if (r?.starting) { await r.starting; return this.running.get(id)?.port; }
    await this.start(id);
    return this.running.get(id)?.port;
  }

  /** Linux server without a screen + Xvfb installed → real (headed) browser on a virtual display. */
  defaultHeadless() {
    return !(process.platform === 'linux' && !process.env.DISPLAY && onPath('Xvfb'));
  }

  /** DISPLAY for headed browsers on a Linux server without a screen (starts one shared Xvfb). */
  async #display() {
    if (process.platform !== 'linux' || process.env.DISPLAY) return process.env.DISPLAY ?? null;
    if (this.xvfb?.display && this.xvfb.proc.exitCode === null) return this.xvfb.display;
    const bin = onPath('Xvfb');
    if (!bin) return null;
    let n = 90;
    while (n < 140 && fs.existsSync(`/tmp/.X11-unix/X${n}`)) n++;
    const proc = spawn(bin, [`:${n}`, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
    this.xvfb = { proc, display: `:${n}` };
    proc.on('exit', () => { if (this.xvfb?.proc === proc) this.xvfb = null; });
    for (let i = 0; i < 50 && !fs.existsSync(`/tmp/.X11-unix/X${n}`); i++) await new Promise((r) => setTimeout(r, 100));
    return fs.existsSync(`/tmp/.X11-unix/X${n}`) ? this.xvfb?.display ?? null : null;
  }

  async start(id) {
    const p = this.get(id);
    if (this.running.has(id)) return;
    if (this.running.size >= this.ctx.config.maxBrowsers) throw new UserError(`Schon ${this.ctx.config.maxBrowsers} Browser offen (MAX_BROWSERS) – erst einen stoppen.`);
    const exe = findBrowserExecutable(p.engine);
    if (!exe) {
      throw new UserError(p.engine === 'chromium'
        ? 'Mitgelieferter Chromium ist nicht installiert – „Browser installieren“ im Browser-Bereich.'
        : `${p.engine === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'} nicht gefunden – im Profil eine andere Engine wählen.`);
    }
    let port = p.port ?? BASE_PORT;
    if (!(await portFree(port))) {
      for (port = BASE_PORT; port < BASE_PORT + 200 && !(await portFree(port)); port++);
      p.port = port;
      await this.#save();
    }
    const userDir = this.dir(id);
    await fsp.mkdir(userDir, { recursive: true });
    const args = [
      `--user-data-dir=${userDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--window-size=1366,860',
    ];
    let headless = p.headless;
    let env = process.env;
    if (!headless && process.platform === 'linux' && !process.env.DISPLAY) {
      const display = await this.#display();
      if (display) env = { ...process.env, DISPLAY: display };
      else headless = true; // no screen and no Xvfb
    }
    if (headless) {
      args.push('--headless=new');
      const ua = headedUserAgent(exe, p.engine);
      if (ua) args.push(`--user-agent=${ua}`);
    }
    if (p.proxy) args.push(`--proxy-server=${p.proxy}`);
    if (p.lang) args.push(`--lang=${p.lang}`);
    if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
    args.push(p.startUrl || 'about:blank');

    const entry = { id, port, headless, proc: null, browser: null, context: null, active: null, cdp: null, viewers: new Set(), lastFrame: null, state: { url: '', title: '', tabs: [] }, ready: false, dialog: null, log: [] };
    this.running.set(id, entry);
    entry.starting = (async () => {
      const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false, env });
      entry.proc = proc;
      proc.stderr.on('data', (d) => {
        entry.log.push(stripAnsi(String(d)).slice(0, 2000));
        if (entry.log.length > 50) entry.log.shift();
      });
      proc.on('exit', () => this.#onExit(id, entry));
      try {
        await waitForCdp(port);
        entry.browser = await withTimeout(chromium.connectOverCDP(`http://127.0.0.1:${port}`), 20_000, 'CDP-Verbindung');
        entry.context = entry.browser.contexts()[0];
        entry.context.on('page', (page) => { this.#watchPage(entry, page); this.#activate(entry, page).catch(() => {}); });
        for (const page of entry.context.pages()) this.#watchPage(entry, page);
        const first = entry.context.pages().at(-1) ?? await entry.context.newPage();
        await this.#activate(entry, first);
        entry.ready = true;
      } catch (e) {
        try { proc.kill(); } catch { /* gone */ }
        this.running.delete(id);
        throw e instanceof UserError ? e : new UserError(`Browser-Start fehlgeschlagen: ${e.message}\n${entry.log.slice(-3).join('')}`);
      } finally {
        entry.starting = null;
        this.emitList();
      }
    })();
    this.emitList();
    await entry.starting;
  }

  #onExit(id, entry) {
    if (this.running.get(id) !== entry) return;
    this.running.delete(id);
    for (const c of entry.viewers) this.ctx.hub.send(c, { t: 'bstate', profileId: id, stopped: true });
    const p = this.profiles.get(id);
    if (p?.temporary) fsp.rm(this.dir(id), { recursive: true, force: true }).catch(() => {});
    this.emitList();
  }

  async stop(id) {
    const entry = this.running.get(id);
    if (!entry) return;
    try {
      const s = await entry.browser?.newBrowserCDPSession();
      await withTimeout(s.send('Browser.close'), 4000, 'Browser.close'); // clean exit flushes cookies
    } catch { /* fall back to kill */ }
    await new Promise((r) => setTimeout(r, 400));
    if (this.running.get(id) === entry) {
      try { entry.proc?.kill(); } catch { /* gone */ }
      this.#onExit(id, entry);
    }
  }

  async stopAll() {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id).catch(() => {})));
    try { this.xvfb?.proc.kill(); } catch { /* gone */ }
  }

  // ------------------------------------------------------------------ pages, screencast

  #watchPage(entry, page) {
    if (page.__cockpitWatched) return;
    page.__cockpitWatched = true;
    const update = () => this.#pushState(entry);
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) update(); });
    page.on('load', update);
    page.on('close', () => {
      if (entry.active === page) {
        const next = entry.context?.pages().filter((p) => !p.isClosed()).at(-1);
        if (next) this.#activate(entry, next).catch(() => {});
        else { entry.active = null; update(); }
      } else update();
    });
    page.on('dialog', (d) => {
      entry.dialog = d;
      for (const c of entry.viewers) this.ctx.hub.send(c, { t: 'bdialog', profileId: entry.id, type: d.type(), message: d.message(), defaultValue: d.defaultValue() });
    });
  }

  async #activate(entry, page) {
    if (!page || page.isClosed()) return;
    entry.active = page;
    entry.lastFrame = null;
    await this.#restartScreencast(entry);
    this.#pushState(entry);
  }

  async #pushState(entry) {
    const pages = entry.context?.pages().filter((p) => !p.isClosed()) ?? [];
    const tabs = await Promise.all(pages.map(async (p, i) => ({ i, url: p.url(), title: await p.title().catch(() => ''), active: p === entry.active })));
    const act = tabs.find((t) => t.active);
    entry.state = { url: act?.url ?? '', title: act?.title ?? '', tabs };
    for (const c of entry.viewers) this.ctx.hub.send(c, { t: 'bstate', profileId: entry.id, ...entry.state });
    this.emitList();
  }

  async #restartScreencast(entry, attempt = 0) {
    try {
      await this.#startScreencast(entry);
    } catch (e) {
      // A page that just opened may not accept CDP commands yet – retry briefly
      if (attempt < 4 && entry.active && !entry.active.isClosed()) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        if (this.running.get(entry.id) === entry) return this.#restartScreencast(entry, attempt + 1);
      } else console.warn(`[browser] Screencast: ${e.message.split('\n')[0]}`);
    }
  }

  async #startScreencast(entry) {
    const old = entry.cdp;
    entry.cdp = null;
    if (old) { try { await old.send('Page.stopScreencast'); await old.detach(); } catch { /* page gone */ } }
    if (!entry.viewers.size || !entry.active || entry.active.isClosed()) return;
    const page = entry.active;
    const cdp = await entry.context.newCDPSession(page);
    entry.cdp = cdp;
    cdp.on('Page.screencastFrame', (f) => {
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      if (entry.cdp !== cdp) return;
      const frame = { t: 'bframe', profileId: entry.id, data: f.data, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight };
      entry.lastFrame = frame;
      for (const c of entry.viewers) {
        if (c.ws.bufferedAmount < 2 * 1024 * 1024) this.ctx.hub.send(c, frame); // drop frames for slow viewers
      }
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 72, maxWidth: 1920, maxHeight: 1200, everyNthFrame: 1 });
  }

  async view(id, client, on) {
    if (!on) {
      const entry = this.running.get(id);
      if (!entry) return;
      entry.viewers.delete(client);
      if (!entry.viewers.size) await this.#restartScreencast(entry);
      this.emitList();
      return;
    }
    await this.ensureRunning(id);
    const entry = this.running.get(id);
    const had = entry.viewers.size;
    entry.viewers.add(client);
    if (!had) await this.#restartScreencast(entry);
    else if (entry.lastFrame) this.ctx.hub.send(client, entry.lastFrame);
    this.ctx.hub.send(client, { t: 'bstate', profileId: id, ...entry.state });
    this.emitList();
  }

  dropClient(client) {
    for (const [id, entry] of this.running) if (entry.viewers.has(client)) this.view(id, client, false).catch(() => {});
  }

  #entry(id) {
    const e = this.running.get(id);
    if (!e?.ready || !e.active) throw new UserError('Browser läuft nicht');
    return e;
  }

  async input(id, ev) {
    const e = this.#entry(id);
    const cdp = e.cdp ?? await e.context.newCDPSession(e.active);
    const modifiers = (ev.alt ? MOD.alt : 0) | (ev.ctrl ? MOD.ctrl : 0) | (ev.meta ? MOD.meta : 0) | (ev.shift ? MOD.shift : 0);
    const x = num(ev.x, 0, 10_000), y = num(ev.y, 0, 10_000);
    switch (ev.kind) {
      case 'mouse': {
        const type = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }[ev.type];
        if (!type) return;
        const button = ['left', 'right', 'middle'].includes(ev.button) ? ev.button : 'none';
        await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !ev.buttons ? 'none' : button, buttons: num(ev.buttons, 0, 7), clickCount: num(ev.clickCount, 0, 3), modifiers });
        return;
      }
      case 'wheel':
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: num(ev.dx, -5000, 5000), deltaY: num(ev.dy, -5000, 5000), modifiers });
        return;
      case 'key': {
        const key = String(ev.key ?? '').slice(0, 32);
        const text = typeof ev.text === 'string' && ev.text.length <= 4 ? ev.text : undefined;
        const base = { key, code: String(ev.code ?? '').slice(0, 32), windowsVirtualKeyCode: num(ev.keyCode, 0, 255), nativeVirtualKeyCode: num(ev.keyCode, 0, 255), modifiers, location: num(ev.location, 0, 3) };
        if (ev.type === 'down') await cdp.send('Input.dispatchKeyEvent', { ...base, type: text && !(modifiers & (MOD.ctrl | MOD.meta)) ? 'keyDown' : 'rawKeyDown', text: modifiers & (MOD.ctrl | MOD.meta) ? undefined : text, unmodifiedText: text });
        else await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
        return;
      }
      case 'text':
        if (typeof ev.text === 'string' && ev.text.length <= 100_000) await cdp.send('Input.insertText', { text: ev.text });
        return;
      default:
    }
  }

  async navigate(id, { action, url }) {
    const e = this.#entry(id);
    const page = e.active;
    const opts = { waitUntil: 'commit', timeout: 30_000 };
    if (action === 'back') await page.goBack(opts).catch(() => {});
    else if (action === 'forward') await page.goForward(opts).catch(() => {});
    else if (action === 'reload') await page.reload(opts).catch(() => {});
    else if (action === 'go') {
      let target = String(url ?? '').trim();
      if (!target) return;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) target = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$|^localhost(:\d+)?/.test(target) ? `https://${target}`.replace(/^https:\/\/localhost/, 'http://localhost') : `https://www.google.com/search?q=${encodeURIComponent(target)}`;
      await page.goto(target, opts).catch((err) => { throw new UserError(`Navigation fehlgeschlagen: ${err.message.split('\n')[0]}`); });
    }
    this.#pushState(e);
  }

  async tab(id, { op, index, url }) {
    const e = this.#entry(id);
    const pages = e.context.pages().filter((p) => !p.isClosed());
    if (op === 'new') {
      const page = await e.context.newPage();
      if (url) await page.goto(String(url), { waitUntil: 'commit' }).catch(() => {});
    } else if (op === 'select' && pages[index]) {
      await pages[index].bringToFront().catch(() => {});
      await this.#activate(e, pages[index]);
    } else if (op === 'close' && pages[index]) {
      if (pages.length === 1) await e.context.newPage();
      await pages[index].close().catch(() => {});
    }
  }

  async resize(id, width, height) {
    const e = this.#entry(id);
    const cdp = await e.context.newCDPSession(e.active);
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      // window size = viewport + browser chrome; headless has none
      const chromeH = e.headless ? 0 : 88;
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: num(width, 320, 3840, 1366), height: num(height, 240, 2400, 860) + chromeH, windowState: 'normal' } });
    } finally { await cdp.detach().catch(() => {}); }
  }

  async answerDialog(id, accept, text) {
    const e = this.#entry(id);
    const d = e.dialog;
    e.dialog = null;
    if (!d) return;
    await (accept ? d.accept(typeof text === 'string' ? text : undefined) : d.dismiss()).catch(() => {});
  }

  // ------------------------------------------------------------------ installation

  installBrowsers() {
    if (this.install.state === 'running') return;
    const cli = path.join(this.ctx.root, 'node_modules', '@playwright', 'mcp', 'cli.js');
    if (!fs.existsSync(cli)) throw new UserError('@playwright/mcp fehlt – npm install ausführen');
    this.install = { state: 'running', lines: [`Ziel: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`] };
    const push = (d) => {
      for (const l of stripAnsi(String(d)).split(/[\r\n]+/)) if (l.trim()) this.install.lines.push(l.trim().slice(0, 300));
      if (this.install.lines.length > 80) this.install.lines.splice(0, this.install.lines.length - 80);
      this.ctx.hub.toAll({ t: 'binstall', install: this.install });
    };
    const proc = spawn(process.execPath, [cli, 'install-browser', 'chromium', 'ffmpeg', '--no-shell'], { env: process.env, windowsHide: true });
    proc.stdout.on('data', push);
    proc.stderr.on('data', push);
    proc.on('close', (code) => {
      this.install.state = code === 0 ? 'done' : 'error';
      push(code === 0 ? 'Fertig.' : `Abgebrochen (Code ${code}).`);
      this.emitList();
    });
    this.ctx.hub.toAll({ t: 'binstall', install: this.install });
  }

  status() {
    return { bundled: !!findBrowserExecutable('chromium'), chrome: !!findBrowserExecutable('chrome'), msedge: !!findBrowserExecutable('msedge'), install: this.install, path: process.env.PLAYWRIGHT_BROWSERS_PATH, defaultHeadless: this.defaultHeadless(), virtualDisplay: process.platform === 'linux' && !process.env.DISPLAY };
  }
}

