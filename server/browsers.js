import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowserExecutable, playwrightMcpCli } from './environment.js';
import { UserError, slugify, stripAnsi, throttle, withTimeout } from './util.js';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENGINES = ['chromium', 'chrome', 'msedge'];
const BASE_PORT = 9230;
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const COLOR_SCHEMES = ['auto', 'light', 'dark'];

/** Stream settings. mode "auto" picks a level from STREAM_LEVELS by measured connection quality. */
const DEFAULT_STREAM = { mode: 'auto', quality: 70, maxWidth: 1920, fps: 30, format: 'jpeg' };
const STREAM_LEVELS = [
  { quality: 85, maxWidth: 1920, fps: 30 },
  { quality: 75, maxWidth: 1920, fps: 30 },
  { quality: 65, maxWidth: 1600, fps: 30 },
  { quality: 55, maxWidth: 1366, fps: 24 },
  { quality: 45, maxWidth: 1100, fps: 20 },
  { quality: 35, maxWidth: 900, fps: 15 },
  { quality: 28, maxWidth: 720, fps: 10 },
];
const AUTO_START_LEVEL = 2;
const PROFILE_DEFAULTS = { proxy: '', lang: 'de-DE', languages: '', timezone: '', colorScheme: 'auto', startUrl: '', color: '#8bb6db', temporary: false };

function withDefaults(p) {
  return { ...PROFILE_DEFAULTS, ...p, stream: { ...DEFAULT_STREAM, ...(p.stream ?? {}) } };
}

/** Accept-Language list of a profile: explicit list, else main language + its base language. */
function acceptLanguages(p) {
  const list = (p.languages || [p.lang, p.lang?.split('-')[0]].filter(Boolean).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(list)].join(',');
}

function cleanStream(input, base) {
  const out = { ...base };
  if (input.mode === 'auto' || input.mode === 'manual') out.mode = input.mode;
  if (input.format === 'jpeg' || input.format === 'png') out.format = input.format;
  if (input.quality !== undefined) out.quality = Math.round(num(input.quality, 10, 100, base.quality));
  if (input.maxWidth !== undefined) out.maxWidth = Math.round(num(input.maxWidth, 480, 3840, base.maxWidth));
  if (input.fps !== undefined) out.fps = Math.round(num(input.fps, 1, 60, base.fps));
  return out;
}

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Accept-Language / navigator.languages of a headed browser come from the profile preferences,
 * --lang only sets the UI language. Write them before the browser starts (it must not be running).
 */
async function writeLanguagePrefs(userDir, languages) {
  if (!languages) return;
  const file = path.join(userDir, 'Default', 'Preferences');
  let prefs = {};
  try { prefs = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return; } // unreadable → leave untouched
  prefs.intl = { ...(prefs.intl ?? {}), accept_languages: languages, selected_languages: languages };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(prefs));
}

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

/** Marker cookie on a domain that can never resolve – invisible to every website. */
const MARKER_COOKIE = 'cockpit-identity';
const MARKER_DOMAIN = 'cockpit-identity.invalid';

/** [site, cookie domain, session cookie names] – presence of a valid one = signed in. */
const LOGIN_COOKIES = [
  ['Google/YouTube', /(^|\.)google\.com$/, ['SID', '__Secure-1PSID']],
  ['LinkedIn', /(^|\.)linkedin\.com$/, ['li_at']],
  ['X/Twitter', /(^|\.)(x|twitter)\.com$/, ['auth_token']],
  ['Facebook', /(^|\.)facebook\.com$/, ['c_user']],
  ['Instagram', /(^|\.)instagram\.com$/, ['sessionid']],
  ['TikTok', /(^|\.)tiktok\.com$/, ['sessionid', 'sessionid_ss']],
  ['GitHub', /(^|\.)github\.com$/, ['user_session']],
  ['Microsoft', /(^|\.)(live|microsoftonline)\.com$/, ['ESTSAUTHPERSISTENT', '__Host-MSAAUTHP']],
  ['Amazon', /(^|\.)amazon\.(de|com)$/, ['at-main', 'at-acbde']],
  ['Reddit', /(^|\.)reddit\.com$/, ['reddit_session', 'token_v2']],
];

/** One CDP command against the browser endpoint on `port` (no Playwright attach). */
async function cdpOnce(port, method, params = {}, ms = 3000) {
  const v = await withTimeout(fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()), ms, 'CDP');
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  try {
    await withTimeout(new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); }), ms, 'CDP');
    ws.send(JSON.stringify({ id: 1, method, params }));
    const msg = await withTimeout(new Promise((resolve) => ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 1) resolve(m); })), ms, 'CDP');
    if (msg.error) throw new Error(msg.error.message);
    return msg.result;
  } finally {
    ws.close();
  }
}

/** Identity id stored in the profile of the browser on `port`, or null if it has none. */
async function readMarker(port) {
  const { cookies = [] } = await cdpOnce(port, 'Storage.getCookies');
  return cookies.find((c) => c.name === MARKER_COOKIE && c.domain.replace(/^\./, '') === MARKER_DOMAIN)?.value ?? null;
}

/** Is a Chromium profile folder in use by a running browser? */
function profileLocked(userDir) {
  if (process.platform === 'win32') {
    // Chromium keeps "lockfile" open exclusively while it runs
    const f = path.join(userDir, 'lockfile');
    if (!fs.existsSync(f)) return false;
    try { fs.closeSync(fs.openSync(f, 'r+')); return false; } catch (e) { return e.code === 'EBUSY' || e.code === 'EPERM'; }
  }
  try {
    const pid = Number(fs.readlinkSync(path.join(userDir, 'SingletonLock')).split('-').pop()); // "<host>-<pid>"
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Last lines of a browser's log file – the reason a start failed. */
function logTail(file, lines = 4) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return stripAnsi(text).trim().split(/\r?\n/).slice(-lines).join('\n').slice(-1500);
  } catch {
    return '';
  }
}

async function waitUnlocked(userDir, ms) {
  const end = Date.now() + ms;
  while (profileLocked(userDir)) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
  return true;
}

/** navigator.platform of a headed browser on this machine. */
function navigatorPlatform() {
  if (process.platform === 'win32') return 'Win32';
  if (process.platform === 'darwin') return 'MacIntel'; // also on Apple Silicon
  return `Linux ${process.arch === 'arm64' ? 'aarch64' : process.arch === 'arm' ? 'armv7l' : 'x86_64'}`;
}

/** A screen for headed browsers: Windows/macOS always, Linux with X11 or Wayland. */
function hasScreen() {
  return process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** User agent of the headed browser – headless Chromium announces "HeadlessChrome", which many logins (Google) reject. */
function headedUserAgent(exe, engine) {
  const major = browserMajor(exe);
  if (!major) return null;
  // what a real headed browser sends: Windows and macOS freeze this part (also on ARM), Linux shows the CPU
  const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : `X11; ${navigatorPlatform()}`;
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${engine === 'msedge' ? ` Edg/${major}.0.0.0` : ''}`;
}

/**
 * Headless Chromium reports "HeadlessChrome" in its client hints (Sec-CH-UA header and
 * navigator.userAgentData) even when --user-agent is set; bot detection (LinkedIn, X, Google,
 * Cloudflare) flags this. Return the metadata of a normal headed browser of the same version.
 */
function headedUaMetadata(fullVersion, engine) {
  const major = String(fullVersion).split('.')[0];
  const brand = engine === 'msedge' ? 'Microsoft Edge' : engine === 'chrome' ? 'Google Chrome' : null;
  const list = (v) => [{ brand: 'Not_A Brand', version: major === v ? '24' : '24.0.0.0' }, { brand: 'Chromium', version: v }, ...(brand ? [{ brand, version: v }] : [])];
  const platform = process.platform === 'win32' ? ['Windows', '15.0.0'] : process.platform === 'darwin' ? ['macOS', '14.0.0'] : ['Linux', ''];
  return {
    brands: list(major), fullVersionList: list(String(fullVersion)), fullVersion: String(fullVersion),
    platform: platform[0], platformVersion: platform[1], architecture: process.arch.startsWith('arm') ? 'arm' : 'x86', bitness: process.arch === 'arm' || process.arch === 'ia32' ? '32' : '64', model: '', mobile: false, wow64: false,
  };
}

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

async function waitForCdp(port, proc, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // e.g. no screen / missing libraries – don't wait 20 s for a process that is gone
    if (proc && (proc.exitCode !== null || proc.signalCode !== null)) {
      await new Promise((r) => setTimeout(r, 150)); // let the last stderr lines arrive
      throw new UserError('Browser hat sich direkt nach dem Start beendet');
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new UserError('Browser antwortet nicht auf dem Debug-Port');
}

/** Lower bound of unsent bytes per viewer before frames are skipped (otherwise 1.5 × frame size). */
const FRAME_BUFFER_MIN = 64 * 1024;
/** End-to-end flow control: max. frames sent but not yet displayed by the viewer … */
const MAX_INFLIGHT = 3;
/** … and max. extra delay over the base round trip before newer frames wait (ms). */
const LATENCY_BUDGET = 200;
/** An unconfirmed frame older than this is considered lost (ms). */
const ACK_TIMEOUT = 3000;

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

  dir(id) {
    const p = this.profiles.get(id);
    // isolated per-project browser keeps the folder Playwright used before (logins stay)
    return p?.isolatedFor ? this.ctx.store.p('browser', p.isolatedFor) : this.ctx.store.p('browsers', id);
  }

  /** Hidden identity for sessions without a linked one: own profile per project, not listed in the UI. */
  async ensureIsolated(projectId, { headless = true } = {}) {
    const id = `iso-${projectId}`.slice(0, 63).replace(/-+$/, '');
    const p = this.profiles.get(id);
    if (p) {
      if (p.headless !== headless) { p.headless = headless; await this.#save(); }
      return id;
    }
    const used = new Set([...this.profiles.values()].map((x) => x.port));
    let port = BASE_PORT;
    while (used.has(port)) port++;
    this.profiles.set(id, withDefaults({ id, name: `Isoliert (${projectId})`, engine: this.defaultEngine(), headless, hidden: true, isolatedFor: projectId, port, createdAt: Date.now() }));
    await this.#save();
    return id;
  }

  /** Project deleted: its isolated browser goes too. */
  async dropIsolated(projectId) {
    for (const p of [...this.profiles.values()]) if (p.isolatedFor === projectId) await this.remove(p.id).catch(() => {});
  }

  async init() {
    const saved = await this.ctx.store.readJson(this.file, []);
    for (const p of Array.isArray(saved) ? saved : []) if (ID_RE.test(p.id)) this.profiles.set(p.id, withDefaults(p));
    // Repair duplicate ports (older versions could hand one identity's port to another)
    const seen = new Set();
    let fixed = false;
    for (const p of this.profiles.values()) {
      if (p.port && seen.has(p.port)) { p.port = null; fixed = true; } else if (p.port) seen.add(p.port);
    }
    for (const p of this.profiles.values()) {
      if (!p.port) { let port = BASE_PORT; while (seen.has(port)) port++; p.port = port; seen.add(port); fixed = true; }
    }
    if (fixed) await this.#save();
    if (![...this.profiles.values()].some((p) => !p.hidden)) await this.create({ name: 'Haupt-Identität' });
  }

  #save() { return this.ctx.store.writeJson(this.file, [...this.profiles.values()]); }

  list({ hidden = false } = {}) {
    return [...this.profiles.values()].filter((p) => hidden || !p.hidden).map((p) => {
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
    if (typeof input.lang === 'string') out.lang = /^[a-z]{2,3}(-[A-Z]{2})?$/.test(input.lang.trim()) ? input.lang.trim() : 'de-DE';
    if (typeof input.languages === 'string') {
      const list = input.languages.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      const bad = list.find((l) => !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(l));
      if (bad) throw new UserError(`Ungültige Sprache „${bad.slice(0, 20)}“ – Format z. B. de-DE, de, en-US`);
      out.languages = [...new Set(list)].slice(0, 10).join(',');
    }
    if (typeof input.timezone === 'string') {
      const tz = input.timezone.trim();
      if (tz && !validTimezone(tz)) throw new UserError(`Unbekannte Zeitzone „${tz.slice(0, 40)}“ – z. B. Europe/Berlin`);
      out.timezone = tz;
    }
    if (COLOR_SCHEMES.includes(input.colorScheme)) out.colorScheme = input.colorScheme;
    if (input.stream && typeof input.stream === 'object') out.stream = cleanStream(input.stream, base.stream ?? DEFAULT_STREAM);
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
    const p = this.#clean(input, withDefaults({ id, name: id, engine: this.defaultEngine(), headless: this.defaultHeadless(), port, createdAt: Date.now() }));
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
    const entry = this.running.get(id);
    let restartNeeded = false;
    if (entry) {
      // time zone, color scheme and stream apply live; process-level settings need a restart
      restartNeeded = ['engine', 'headless', 'proxy', 'lang', 'languages'].some((k) => p[k] !== next[k]);
      entry.profile = next;
      for (const s of entry.identity.values()) this.#applyIdentity(entry, s).catch(() => {});
      if (JSON.stringify(p.stream) !== JSON.stringify(next.stream)) this.#streamChanged(entry);
    }
    this.emitList();
    return { ...next, restartNeeded };
  }

  /** Change only the stream settings (live, from the browser view). */
  async setStream(id, stream) {
    const p = this.get(id);
    return this.update(id, { stream: { ...p.stream, ...(stream ?? {}) } });
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
    // headed browsers look like a normal user to bot detection; only fall back to headless without a screen
    return !hasScreen() && !onPath('Xvfb');
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

  async start(id, { forceHeadless = false, noSandbox = false } = {}) {
    const p = this.get(id);
    if (this.running.has(id)) return;
    if (this.running.size >= this.ctx.config.maxBrowsers) throw new UserError(`Schon ${this.ctx.config.maxBrowsers} Browser offen (MAX_BROWSERS) – erst einen stoppen.`);
    const exe = findBrowserExecutable(p.engine);
    if (!exe) {
      throw new UserError(p.engine === 'chromium'
        ? 'Mitgelieferter Chromium ist nicht installiert – „Browser installieren“ im Browser-Bereich.'
        : `${p.engine === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'} nicht gefunden – im Profil eine andere Engine wählen.`);
    }
    const userDir = this.dir(id);
    await this.ctx.janitor?.profileJob(id); // cache cleanup of this profile still running → wait
    await fsp.mkdir(userDir, { recursive: true });
    // Each identity keeps its own port – never one reserved by another identity. A Claude session
    // stays connected to that port, so a taken-over port would hand it a different identity.
    let port = p.port ?? await this.#freePort(id);
    let adopt = false;
    if (!(await portFree(port))) {
      // Still running from before a cockpit restart/crash (Windows keeps child processes alive)?
      adopt = await this.#isOwnBrowser(id, port, userDir);
      if (!adopt) port = await this.#freePort(id);
    }
    // A browser still holding the profile (just closed and shutting down, or opened by hand) would make
    // the new process hand over to it and exit at once – wait briefly, then give a clear message.
    if (!adopt && profileLocked(userDir) && !(await waitUnlocked(userDir, 6000))) {
      throw new UserError('Das Profil wird noch von einem anderen Browserfenster verwendet – dieses Fenster schließen und erneut starten.');
    }
    if (p.port !== port) { p.port = port; await this.#save(); }
    const args = [
      `--user-data-dir=${userDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      // identities stay separate: no browser sync (Edge otherwise signs fresh profiles into the
      // Windows Microsoft account and syncs passwords/history/tabs between all of them)
      '--disable-sync',
      '--disk-cache-size=268435456', // HTTP cache max. 256 MB per identity (default grows with the disk)
      `--disable-features=Translate,MediaRouter${process.platform === 'win32' ? ',CalculateNativeWinOcclusion' : ''}`,
      '--window-size=1366,860',
      // keep rendering (and the screencast) going when the window is covered or in the background
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ];
    let headless = p.headless || forceHeadless;
    let env = process.env;
    if (!headless && !hasScreen()) {
      const display = await this.#display();
      if (display) env = { ...process.env, DISPLAY: display };
      else headless = true; // no screen and no Xvfb
    }
    if (!headless && process.platform === 'linux') args.push('--ozone-platform-hint=auto'); // native Wayland or X11
    if (headless) {
      args.push('--headless=new');
      const ua = headedUserAgent(exe, p.engine);
      if (ua) args.push(`--user-agent=${ua}`);
    }
    if (p.proxy) args.push(`--proxy-server=${p.proxy}`);
    if (p.lang) args.push(`--lang=${p.lang}`);
    await writeLanguagePrefs(userDir, acceptLanguages(p)).catch(() => {});
    if (noSandbox || (process.platform === 'linux' && process.getuid?.() === 0)) args.push('--no-sandbox');
    args.push(p.startUrl || 'about:blank');

    const entry = { id, port, headless, profile: p, uaPatch: null, identity: new Map(), vs: new Map(), level: AUTO_START_LEVEL, net: { sent: 0, skipped: 0, bytes: 0, good: 0, frames: 0 }, proc: null, browser: null, context: null, active: null, cdp: null, viewers: new Set(), lastFrame: null, state: { url: '', title: '', tabs: [] }, ready: false, dialog: null, log: [] };
    this.running.set(id, entry);
    entry.starting = (async () => {
      let proc = null;
      if (adopt) {
        console.log(`[browser] ${id}: laufenden Browser übernommen (Port ${port})`);
      } else {
        // Independent of the cockpit process: on Windows a non-detached child sits in a kill-on-close job
        // and is hard-killed (losing unsaved cookies/logins) when the cockpit crashes or is closed; a stderr
        // pipe could break the same way. A cleanly stopped cockpit still closes it (stopAll), after a
        // crash it keeps running and the next cockpit adopts it.
        const logDir = this.ctx.store.p('browser-logs');
        await fsp.mkdir(logDir, { recursive: true });
        entry.logFile = path.join(logDir, `${id}.log`);
        const fd = fs.openSync(entry.logFile, 'w');
        try {
          proc = spawn(exe, args, { stdio: ['ignore', 'ignore', fd], windowsHide: false, env, detached: true });
        } finally {
          fs.closeSync(fd);
        }
        proc.unref();
        entry.proc = proc;
        proc.on('exit', () => this.#onExit(id, entry));
      }
      try {
        await waitForCdp(port, proc);
        entry.browser = await withTimeout(chromium.connectOverCDP(`http://127.0.0.1:${port}`), 20_000, 'CDP-Verbindung');
        entry.browser.on('disconnected', () => this.#onExit(id, entry)); // closed by the user, crashed, adopted one ended
        entry.context = entry.browser.contexts()[0];
        if (adopt) entry.headless = headless = /Headless/i.test(await entry.browser.newBrowserCDPSession().then((s) => s.send('Browser.getVersion')).then((v) => v.product).catch(() => ''));
        await this.#markProfile(entry.browser, id);
        if (headless) {
          const ua = headedUserAgent(exe, p.engine) ?? (await entry.browser.newBrowserCDPSession().then((s) => s.send('Browser.getVersion')).then((v) => v.userAgent.replace('HeadlessChrome', 'Chrome')).catch(() => null));
          if (ua) entry.uaPatch = { userAgent: ua, platform: navigatorPlatform(), userAgentMetadata: headedUaMetadata(entry.browser.version(), p.engine) };
        }
        entry.statsTimer = setInterval(() => this.#tickStream(entry), 1500);
        entry.context.on('page', (page) => { this.#watchPage(entry, page); this.#activate(entry, page).catch(() => {}); });
        for (const page of entry.context.pages()) this.#watchPage(entry, page);
        const first = entry.context.pages().at(-1) ?? await entry.context.newPage();
        await this.#activate(entry, first);
        entry.ready = true;
      } catch (e) {
        try { proc?.kill(); } catch { /* gone */ }
        this.running.delete(id);
        const detail = logTail(entry.logFile);
        throw new UserError(`${e instanceof UserError ? e.message : `Browser-Start fehlgeschlagen: ${e.message}`}${detail ? `\n${detail}` : ''}`);
      } finally {
        entry.starting = null;
        this.emitList();
      }
    })();
    this.emitList();
    try {
      await entry.starting;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 300)); // let the profile lock go
      // Ubuntu ≥ 23.10 (AppArmor) blocks the sandbox of browsers without their own profile, e.g. the bundled Chromium
      if (process.platform === 'linux' && !noSandbox && /sandbox/i.test(e.message)) {
        console.warn(`[browser] ${id}: Sandbox nicht verfügbar, starte mit --no-sandbox`);
        return this.start(id, { forceHeadless, noSandbox: true });
      }
      // A visible window can fail where headless works (macOS without GUI login, Linux without
      // display libraries). Better a running browser than none – the profile setting stays.
      if (headless) throw e;
      console.warn(`[browser] ${id}: sichtbarer Start fehlgeschlagen, versuche headless – ${e.message.split('\n')[0]}`);
      return this.start(id, { forceHeadless: true, noSandbox });
    }
  }

  /** Is the identity's profile folder held by a browser process (also one not managed by this cockpit)? */
  profileInUse(id) {
    return profileLocked(this.dir(id));
  }

  /** A port that is free and not reserved by any other identity. */
  async #freePort(id) {
    const reserved = new Set([...this.profiles.values()].filter((x) => x.id !== id).map((x) => x.port).filter(Boolean));
    for (let port = BASE_PORT; port < BASE_PORT + 400; port++) {
      if (!reserved.has(port) && await portFree(port)) return port;
    }
    throw new UserError('Kein freier Debug-Port für den Browser gefunden');
  }

  /**
   * Is the browser listening on `port` this identity's own one (left running by a previous cockpit
   * process)? Verified by the marker cookie in its profile; older profiles without a marker count when
   * their profile folder is in use. A browser of another identity or a foreign one is never adopted.
   */
  async #isOwnBrowser(id, port, userDir) {
    try {
      const marker = await readMarker(port);
      if (marker) return marker === id;
      return profileLocked(userDir);
    } catch {
      return false;
    }
  }

  /**
   * Where a running identity is signed in – read from the sites' login cookies (names only), so Claude
   * gets ground truth for this exact browser instead of remembering what it saw in another identity.
   */
  async loginHints(id) {
    const e = this.running.get(id);
    if (!e?.ready) return null;
    try {
      const { cookies = [] } = await cdpOnce(e.port, 'Storage.getCookies');
      const has = (domainRe, names) => cookies.some((c) => domainRe.test(c.domain.replace(/^\./, '')) && names.includes(c.name) && (c.expires <= 0 || c.expires * 1000 > Date.now()));
      return LOGIN_COOKIES.filter(([, re, names]) => has(re, names)).map(([site]) => site);
    } catch {
      return null;
    }
  }

  /** Persistent marker cookie: lets a later cockpit process recognise this identity's browser. */
  async #markProfile(browser, id) {
    try {
      const s = await browser.newBrowserCDPSession();
      await s.send('Storage.setCookies', { cookies: [{ name: MARKER_COOKIE, value: id, domain: MARKER_DOMAIN, path: '/', expires: Math.floor(Date.now() / 1000) + 10 * 365 * 86400 }] });
      await s.detach();
    } catch { /* marker is a safety net only */ }
  }

  #onExit(id, entry) {
    clearInterval(entry.statsTimer);
    clearTimeout(entry.flushTimer);
    clearTimeout(entry.trailTimer);
    if (this.running.get(id) !== entry) return;
    this.running.delete(id);
    for (const c of entry.viewers) this.ctx.hub.send(c, { t: 'bstate', profileId: id, stopped: true });
    const p = this.profiles.get(id);
    if (p?.temporary) fsp.rm(this.dir(id), { recursive: true, force: true }).catch(() => {});
    // empty the caches once the process has really released the profile (no-op below PROFILE_CACHE_MB)
    else if (this.ctx.config.cleanup && this.ctx.janitor) {
      setTimeout(() => this.ctx.janitor.cleanProfile(id).catch(() => {}), 8000).unref?.();
    }
    this.emitList();
  }

  async stop(id) {
    const entry = this.running.get(id);
    if (!entry) return;
    const exited = entry.proc && entry.proc.exitCode === null ? new Promise((r) => entry.proc.once('exit', r)) : null;
    try {
      const s = await entry.browser?.newBrowserCDPSession();
      await withTimeout(s.send('Browser.close'), 4000, 'Browser.close'); // clean exit flushes cookies
    } catch { /* fall back to kill */ }
    // wait until the process is really gone (it releases the profile lock last), kill if it hangs
    if (exited) {
      const ok = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 6000))]);
      if (!ok) { try { entry.proc.kill(); } catch { /* gone */ } }
    } else {
      await waitUnlocked(this.dir(id), 6000); // adopted browser: no process handle
    }
    if (this.running.get(id) === entry) this.#onExit(id, entry);
  }

  async stopAll() {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id).catch(() => {})));
    try { this.xvfb?.proc.kill(); } catch { /* gone */ }
  }

  // ------------------------------------------------------------------ pages, screencast

  #watchPage(entry, page) {
    if (page.__cockpitWatched) return;
    page.__cockpitWatched = true;
    // Emulation overrides live as long as their session stays attached → one session per page lifetime
    entry.context.newCDPSession(page).then((s) => {
      if (page.isClosed()) return;
      entry.identity.set(page, s);
      return this.#applyIdentity(entry, s);
    }).catch(() => {});
    const update = () => this.#pushState(entry);
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) update(); });
    page.on('load', update);
    page.on('close', () => {
      entry.identity.delete(page);
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

  /** Language, time zone, color scheme (and for headless: headed client hints) of one page. */
  async #applyIdentity(entry, s) {
    const p = entry.profile;
    const langs = acceptLanguages(p);
    const jobs = [];
    if (entry.uaPatch) jobs.push(s.send('Emulation.setUserAgentOverride', { ...entry.uaPatch, ...(langs ? { acceptLanguage: langs } : {}) }));
    if (p.lang) jobs.push(s.send('Emulation.setLocaleOverride', { locale: p.lang.replace('-', '_') }).catch(() => {})); // fails if already set by another session
    jobs.push(s.send('Emulation.setTimezoneOverride', { timezoneId: p.timezone || '' }).catch(() => {})); // '' = system zone
    jobs.push(s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: p.colorScheme === 'auto' ? '' : p.colorScheme }] }));
    await Promise.all(jobs);
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
    entry.frameAt = 0;
    entry.sentAt = 0;
    cdp.on('Page.screencastFrame', (f) => {
      // fps limit, part 1: delaying the ack slows Chrome down (saves CPU). Capped at one frame gap –
      // Chrome keeps a few frames in flight, so uncapped delays would add up and stall the stream.
      const now = Date.now();
      const gap = 1000 / this.#streamParams(entry).fps;
      const wait = Math.min(gap, Math.max(0, entry.frameAt + gap - now));
      entry.frameAt = now + wait;
      setTimeout(() => cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}), wait);
      if (entry.cdp !== cdp) return;
      entry.lastFrame = { t: 'bframe', profileId: entry.id, data: f.data, fmt: entry.streamFormat, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight };
      // part 2: forward at most one frame per gap; a trailing send makes sure the final picture arrives
      const due = entry.sentAt + gap * 0.9 - now;
      if (due <= 0) this.#forwardFrame(entry);
      else if (!entry.trailTimer) entry.trailTimer = setTimeout(() => { entry.trailTimer = null; if (entry.cdp === cdp) this.#forwardFrame(entry); }, due);
    });
    await this.#screencastOn(entry, cdp);
  }

  #forwardFrame(entry) {
    clearTimeout(entry.trailTimer);
    entry.trailTimer = null;
    entry.sentAt = Date.now();
    entry.net.frames++;
    entry.lastFrame.seq = entry.seq = (entry.seq ?? 0) + 1;
    for (const c of entry.viewers) this.#sendFrame(entry, c, true);
  }

  /** Per-viewer delivery state: frames sent but not yet confirmed as displayed. */
  #viewerState(entry, c) {
    let vs = entry.vs.get(c);
    if (!vs) entry.vs.set(c, vs = { inflight: [], acks: 0, legacy: false, win: { sum: 0, n: 0, min: Infinity }, mins: [] });
    return vs;
  }

  /** Lowest round trip of the last ~20 s ≈ pure network + decode time without any queue. */
  #baseRtt(vs) {
    return vs.mins.length ? Math.min(...vs.mins) : Infinity;
  }

  /**
   * The viewer confirmed it has displayed frame `seq`. This end-to-end feedback also covers buffers
   * the server cannot see (OS socket buffer, tunnel/proxy, slow decoding on the phone).
   */
  frameAck(id, client, seq) {
    const entry = this.running.get(id);
    const vs = entry?.vs.get(client);
    if (!vs || !Number.isFinite(seq)) return;
    const hit = vs.inflight.find((f) => f.seq === seq);
    if (hit) {
      const rtt = Date.now() - hit.t;
      vs.win.sum += rtt; vs.win.n++; vs.win.min = Math.min(vs.win.min, rtt);
      vs.acks++;
    }
    vs.legacy = false; // acks arrive → flow control on (a slow first frame may have looked like an old UI)
    vs.inflight = vs.inflight.filter((f) => f.seq > seq);
    if (entry.stale?.has(client) && entry.lastFrame) this.#sendFrame(entry, client); // newest frame right away
  }

  /** Effective stream settings: manual values, or the level the auto control currently chose. */
  #streamParams(entry) {
    const s = entry.profile.stream ?? DEFAULT_STREAM;
    if (s.mode !== 'auto') return s;
    return { ...STREAM_LEVELS[entry.level], format: 'jpeg' };
  }

  async #screencastOn(entry, cdp) {
    const s = this.#streamParams(entry);
    entry.streamFormat = s.format;
    await cdp.send('Page.startScreencast', { format: s.format, ...(s.format === 'jpeg' ? { quality: s.quality } : {}), maxWidth: s.maxWidth, maxHeight: s.maxWidth, everyNthFrame: 1 });
  }

  /** Apply new stream settings to a running screencast without reconnecting. */
  async #streamChanged(entry) {
    entry.net = { sent: 0, skipped: 0, bytes: 0, good: 0, frames: 0 };
    if (!entry.cdp) return;
    // fresh session: restarting the screencast on the same session leaves Chrome waiting for acks of dropped frames
    await this.#restartScreencast(entry);
    this.#sendStats(entry, 0);
  }

  /**
   * Every 1.5 s: measure what reached the viewers. Auto mode steps quality down as soon as frames
   * have to be skipped (connection too slow) and back up after ~5 s without any backlog.
   */
  #tickStream(entry) {
    if (!entry.viewers.size) return;
    const n = entry.net;
    // per viewer: average round trip of this window and how much of it is queueing (above the base RTT)
    let rtt = null, queue = null;
    for (const c of entry.viewers) {
      const vs = this.#viewerState(entry, c);
      if (vs.win.n) {
        vs.mins.push(vs.win.min);
        if (vs.mins.length > 13) vs.mins.shift(); // ~20 s
        const avg = vs.win.sum / vs.win.n;
        const q = Math.max(0, avg - this.#baseRtt(vs));
        if (queue === null || q > queue) { queue = q; rtt = avg; } // the worst viewer decides
      }
      vs.win = { sum: 0, n: 0, min: Infinity };
    }
    n.rtt = rtt; n.queue = queue;
    const total = n.sent + n.skipped;
    if ((entry.profile.stream?.mode ?? 'auto') === 'auto' && total > 0) {
      const skip = n.skipped / total;
      const q = queue ?? 0; // no acks (old UI) → skip ratio alone
      let level = entry.level;
      if (skip > 0.5 || q > 600) level += 2;
      else if (skip > 0.2 || q > 250) level += 1;
      else if (q < 100 && skip < 0.05 && ++n.good >= 2) level -= 1;
      else if (q >= 100 || skip >= 0.05) n.good = 0;
      level = Math.max(0, Math.min(STREAM_LEVELS.length - 1, level));
      if (level !== entry.level) {
        entry.level = level;
        this.#sendStats(entry, 1.5);
        this.#streamChanged(entry).catch(() => {});
        return;
      }
    }
    this.#sendStats(entry, 1.5);
    Object.assign(n, { sent: 0, skipped: 0, bytes: 0, frames: 0 });
  }

  #sendStats(entry, secs) {
    const n = entry.net, s = this.#streamParams(entry);
    const msg = {
      t: 'bstats', profileId: entry.id, mode: entry.profile.stream?.mode ?? 'auto', level: entry.level, levels: STREAM_LEVELS.length,
      quality: s.quality, maxWidth: s.maxWidth, fpsLimit: s.fps, format: s.format,
      fps: secs ? Math.round((n.frames / secs) * 10) / 10 : null, kbps: secs ? Math.round((n.bytes * 8) / secs / 1000) : null, // null = settings changed, no new measurement yet
      skipped: n.skipped, frameKb: entry.lastFrame ? Math.round(entry.lastFrame.data.length / 1024) : 0,
      rtt: n.rtt == null ? null : Math.round(n.rtt), queue: n.queue == null ? null : Math.round(n.queue),
    };
    for (const c of entry.viewers) this.ctx.hub.send(c, msg);
  }

  /**
   * Latest frame wins: never queue frames behind a busy socket (that is what makes a stream lag).
   * A viewer whose buffer is still full gets only the newest frame once it has drained.
   */
  #sendFrame(entry, c, fresh = false) {
    const now = Date.now();
    const size = entry.lastFrame.data.length;
    const limit = Math.max(FRAME_BUFFER_MIN, size * 1.5); // ≈ at most one frame in the local socket
    const buffered = c.ws.bufferedAmount;
    const vs = this.#viewerState(entry, c);
    const oldest = vs.inflight[0];
    if (oldest && now - oldest.t > ACK_TIMEOUT) {
      if (!vs.acks) vs.legacy = true; // UI without frame acks (old cached version) → socket buffer only
      vs.inflight = vs.inflight.filter((f) => now - f.t <= ACK_TIMEOUT);
    }
    // In flight = sent, not yet displayed. Cap the count and the age (base RTT + latency budget),
    // so a congested path never fills with old frames that TCP would still have to deliver.
    const head = vs.inflight[0];
    const budget = Math.min(ACK_TIMEOUT, (Number.isFinite(this.#baseRtt(vs)) ? this.#baseRtt(vs) : 300) + LATENCY_BUDGET);
    const ackBlocked = !vs.legacy && (vs.inflight.length >= MAX_INFLIGHT || (head && now - head.t > budget));
    const bufBlocked = buffered >= limit;
    if (!ackBlocked && !bufBlocked) {
      entry.stale?.delete(c);
      if (fresh) entry.net.sent++;
      entry.net.bytes += size;
      if (!vs.legacy && entry.lastFrame.seq) vs.inflight.push({ seq: entry.lastFrame.seq, t: now });
      this.ctx.hub.send(c, entry.lastFrame);
      return;
    }
    if (fresh) entry.net.skipped++;
    (entry.stale ??= new Set()).add(c);
    if (entry.flushTimer) return;
    // the ack sends the newest frame immediately; the timer covers socket backpressure and lost acks
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = null;
      for (const v of [...(entry.stale ?? [])]) {
        if (!entry.viewers.has(v) || v.ws.readyState !== 1) entry.stale.delete(v);
        else if (entry.lastFrame) this.#sendFrame(entry, v);
      }
    }, bufBlocked ? 30 : 100);
  }

  async view(id, client, on) {
    if (!on) {
      const entry = this.running.get(id);
      if (!entry) return;
      entry.viewers.delete(client);
      entry.vs.delete(client);
      entry.stale?.delete(client);
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
    try {
      await this.#dispatchInput(e, e.cdp ?? await e.context.newCDPSession(e.active), ev);
    } catch (err) {
      if (!/closed|detached|No target/i.test(err.message)) throw err;
      // The viewed tab just closed (by the page, by Claude or another tool) – the event is meaningless
      // now; show the remaining tab instead of failing every further mouse move.
      const next = e.context?.pages().filter((p) => !p.isClosed()).at(-1);
      if (next && (next !== e.active || e.active.isClosed())) await this.#activate(e, next).catch(() => {});
    }
  }

  async #dispatchInput(e, cdp, ev) {
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
    const cli = playwrightMcpCli();
    if (!cli) throw new UserError('@playwright/mcp fehlt – npm install ausführen');
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
    return { bundled: !!findBrowserExecutable('chromium'), chrome: !!findBrowserExecutable('chrome'), msedge: !!findBrowserExecutable('msedge'), install: this.install, path: process.env.PLAYWRIGHT_BROWSERS_PATH, defaultHeadless: this.defaultHeadless(), virtualDisplay: !hasScreen() };
  }
}

