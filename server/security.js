import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cliCmd } from './config.js';
import { UserError, safeEqual } from './util.js';

const COOKIE = 'cockpit_s';
const SESSION_IDLE_MS = 30 * 24 * 3600_000;
const MIN_PASSWORD = 4;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_NAMES = ['localhost', '127.0.0.1', '[::1]'];

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  try { fs.renameSync(tmp, file); } catch { fs.copyFileSync(tmp, file); fs.rmSync(tmp, { force: true }); } // Windows EPERM
}

function loadOrCreateToken(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch { /* create below */ }
  const t = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}

// ---- password (scrypt) -----------------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashPassword(password, rev = 1) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT);
  return { v: 1, rev, salt: salt.toString('base64'), hash: hash.toString('base64'), at: Date.now() };
}
function verifyPassword(password, rec) {
  if (!rec?.salt || !rec?.hash) return false;
  const hash = crypto.scryptSync(String(password), Buffer.from(rec.salt, 'base64'), 64, SCRYPT);
  const want = Buffer.from(rec.hash, 'base64');
  return want.length === hash.length && crypto.timingSafeEqual(want, hash);
}
export function passwordFile(dataDir) { return path.join(dataDir, 'auth.json'); }
export function setupCodeFile(dataDir) { return path.join(dataDir, '.setup-code'); }
export function validatePassword(pw) {
  const s = String(pw ?? '');
  if (s.length < MIN_PASSWORD) return `Mindestens ${MIN_PASSWORD} Zeichen.`;
  if (s.length > 256) return 'Höchstens 256 Zeichen.';
  if (/^(.)\1+$/.test(s)) return 'Bitte kein Passwort aus einem einzigen Zeichen.';
  return null;
}

function readForm(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > limit) { reject(new Error('zu groß')); req.destroy(); } });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', reject);
  });
}

/**
 * Access control
 *  - Sessions: random id in an HttpOnly, SameSite=Strict cookie (Secure behind HTTPS); only its hash is stored.
 *    Created by the console link (?token=…), the password login or the first-run setup. Changing the
 *    password invalidates every other session.
 *  - First run (no password yet): every page asks to set one. Proof of ownership: a session from the
 *    console link, or the one-time setup code printed in the server console.
 *  - Addresses: loopback always; other host names (tunnels, domains) become trusted when the owner signs
 *    in through them (or via PUBLIC_URL). Until then they only get the login page – this keeps DNS
 *    rebinding and foreign domains away from anything but the password form.
 *  - Reverse proxies / tunnels on the same machine (cloudflared, devtunnel, tailscale serve, Caddy):
 *    X-Forwarded-Host/-Proto/-For are honoured only when the TCP peer is loopback.
 *  - Origin check for WebSocket upgrades and every non-GET request (CSRF / cross-site WebSocket).
 *  - Failed logins: 5 per client per minute, plus a global brake against distributed guessing.
 */
export function createSecurity({ config, port = config.port }) {
  const dir = config.dataDir;
  const tokenFile = path.join(dir, '.token');
  let token = loadOrCreateToken(tokenFile);
  const previewToken = crypto.randomBytes(18).toString('base64url');
  const pwFile = passwordFile(dir);
  const hostsFile = path.join(dir, 'remote.json');
  const sessionsFile = path.join(dir, 'sessions.json');

  let pwCache = { mtime: -1, rec: null };
  const password = () => {
    let mtime = 0;
    try { mtime = fs.statSync(pwFile).mtimeMs; } catch { mtime = 0; }
    if (mtime !== pwCache.mtime) pwCache = { mtime, rec: mtime ? readJson(pwFile, null) : null };
    return pwCache.rec;
  };
  const rev = () => password()?.rev ?? 0;

  // one-time setup code while no password exists (also readable via `npm run link`)
  let setupCode = null;
  const ensureSetupCode = () => {
    if (password()) { setupCode = null; fs.rmSync(setupCodeFile(dir), { force: true }); return null; }
    if (!setupCode) {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const raw = Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
      setupCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(setupCodeFile(dir), setupCode, { mode: 0o600 });
    }
    return setupCode;
  };
  ensureSetupCode();

  // ---- trusted addresses
  const staticOrigins = new Set(LOCAL_NAMES.map((h) => `http://${h}:${port}`));
  const staticHosts = new Set(LOCAL_NAMES.map((h) => `${h}:${port}`));
  for (const o of [...config.devOrigins, ...config.publicUrls]) {
    try { const u = new URL(o); staticOrigins.add(u.origin); staticHosts.add(u.host.toLowerCase()); } catch { console.warn(`[security] ungültige URL: ${o}`); }
  }
  let learned = readJson(hostsFile, { hosts: [] }).hosts ?? [];
  const isLocalHost = (h) => LOCAL_NAMES.some((n) => h === `${n}:${port}`);
  const hostTrusted = (h) => !!h && (staticHosts.has(h) || learned.some((x) => x.host === h));
  const trustHost = (h, proto) => {
    if (!h || hostTrusted(h)) return;
    learned = [...learned, { host: h, origin: `${proto}://${h}`, addedAt: Date.now() }];
    writeJson(hostsFile, { hosts: learned });
    console.log(`[security] Adresse freigegeben: ${proto}://${h}`);
  };

  // ---- request facts (proxy-aware)
  const viaLocalProxy = (req) => LOOPBACK.has(req.socket?.remoteAddress ?? '');
  const first = (v) => String(v ?? '').split(',')[0].trim();
  const requestHost = (req) => {
    const fwd = viaLocalProxy(req) ? first(req.headers['x-forwarded-host']) : '';
    return (fwd || String(req.headers.host ?? '')).toLowerCase();
  };
  const requestProto = (req) => {
    const fwd = viaLocalProxy(req) ? first(req.headers['x-forwarded-proto']).toLowerCase() : '';
    if (fwd === 'https' || fwd === 'http') return fwd;
    return isLocalHost(requestHost(req)) ? 'http' : 'https';
  };
  const isLocalRequest = (req) => isLocalHost(requestHost(req)) && !req.headers['x-forwarded-host'] && !req.headers['x-forwarded-for'];
  const clientIp = (req) => {
    if (!viaLocalProxy(req)) return req.socket?.remoteAddress ?? '?';
    return first(req.headers['cf-connecting-ip']) || first(req.headers['x-forwarded-for']) || 'lokal';
  };
  /** Origin names the address the request came in on (or a tunnel rewrote it to localhost). */
  const sameOrigin = (req) => {
    let u;
    try { u = new URL(String(req.headers.origin)); } catch { return false; }
    if (u.host.toLowerCase() === requestHost(req)) return true;
    // dev tunnels rewrite Origin (and Host) to localhost by default; the request still came through the local tunnel client
    return viaLocalProxy(req) && !!req.headers['x-forwarded-host'] && ['localhost', '127.0.0.1'].includes(u.hostname);
  };
  const originOk = (req) => typeof req.headers.origin === 'string'
    && (staticOrigins.has(req.headers.origin) || (sameOrigin(req) && hostTrusted(requestHost(req))));

  // ---- sessions
  const sessions = new Map(Object.entries(readJson(sessionsFile, {})));
  const persist = () => writeJson(sessionsFile, Object.fromEntries(sessions));
  let persistTimer = null;
  const persistSoon = () => { if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = null; persist(); }, 30_000); };
  const sessionFrom = (req) => {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (!raw || raw.length < 40) return null;
    const id = sha(raw);
    const s = sessions.get(id);
    if (!s) return null;
    if (s.rev !== rev() || Date.now() - s.seen > SESSION_IDLE_MS) { sessions.delete(id); persistSoon(); return null; }
    if (Date.now() - s.seen > 60_000) { s.seen = Date.now(); persistSoon(); }
    return { id, ...s };
  };
  const createSession = (req, res, via) => {
    const raw = crypto.randomBytes(32).toString('base64url');
    const s = { rev: rev(), via, created: Date.now(), seen: Date.now(), ip: clientIp(req), host: requestHost(req), ua: String(req.headers['user-agent'] ?? '').slice(0, 200) };
    sessions.set(sha(raw), s);
    persist();
    const secure = requestProto(req) === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_IDLE_MS / 1000}${secure}`);
  };
  const clearCookie = (res) => res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  // drop sessions of an older password revision
  for (const [id, s] of sessions) if (s.rev !== rev()) sessions.delete(id);

  // ---- brute-force brake
  const failures = new Map(); // ip → { n, until }
  let global = { n: 0, since: Date.now(), until: 0 };
  const blocked = (ip) => {
    const f = failures.get(ip);
    return (f && f.until > Date.now()) || global.until > Date.now();
  };
  const fail = (ip) => {
    const f = failures.get(ip);
    const n = (f?.n ?? 0) + 1;
    failures.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
    if (Date.now() - global.since > 300_000) global = { n: 0, since: Date.now(), until: 0 };
    if (++global.n >= 30) global.until = Date.now() + 60_000;
    if (failures.size > 5000) failures.clear();
  };
  const succeed = (ip) => failures.delete(ip);

  function savePassword(pw) {
    const err = validatePassword(pw);
    if (err) throw new UserError(err);
    const next = hashPassword(pw, rev() + 1);
    writeJson(pwFile, next);
    ensureSetupCode();
    return next.rev;
  }

  // ---- HTTP middleware
  async function middleware(req, res, next) {
    const host = requestHost(req);
    if (!host) return res.status(400).end();
    const proto = requestProto(req);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin'); // keeps Origin on same-origin form posts; nothing leaks to other sites
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    if (proto === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const page = (status, html) => res.status(status).type('html').setHeader('Cache-Control', 'no-store').send(html);

    // console link (proves access to the server console)
    if (req.method === 'GET' && typeof req.query.token === 'string') {
      if (!safeEqual(req.query.token, token)) return page(403, authPage({ mode: password() ? 'login' : 'setup', error: 'Ungültiger oder veralteter Zugangslink.' }));
      trustHost(host, proto);
      createSession(req, res, 'link');
      return res.redirect(302, '/');
    }

    if (req.method === 'POST' && (req.path === '/login' || req.path === '/setup')) {
      const o = req.headers.origin;
      const sameSite = req.headers['sec-fetch-site'] === 'same-origin' || req.headers['sec-fetch-site'] === 'none';
      if (o && !staticOrigins.has(o) && !sameOrigin(req) && !(o === 'null' && sameSite)) return res.status(403).end();
      const ip = clientIp(req);
      const mode = password() ? 'login' : 'setup';
      if (blocked(ip)) return page(429, authPage({ mode, error: 'Zu viele Versuche – eine Minute warten.' }));
      const body = await readForm(req).catch(() => new URLSearchParams());
      if (req.path === '/login') {
        const rec = password();
        if (rec && verifyPassword(body.get('password') ?? '', rec)) {
          succeed(ip);
          trustHost(host, proto);
          createSession(req, res, 'password');
          return res.redirect(302, '/');
        }
        fail(ip);
        return page(401, authPage({ mode, error: rec ? 'Falsches Passwort.' : 'Noch kein Passwort – bitte einrichten.' }));
      }
      // first-run setup through the setup code
      if (password()) return page(409, authPage({ mode: 'login', error: 'Passwort ist bereits gesetzt.' }));
      const code = String(body.get('code') ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!setupCode || !safeEqual(code, setupCode.replace('-', ''))) { fail(ip); return page(401, authPage({ mode, error: `Einrichtungscode stimmt nicht (steht in der Server-Konsole bzw. ${cliCmd('link')}).` })); }
      const pw = body.get('password') ?? '';
      if (pw !== (body.get('password2') ?? '')) return page(400, authPage({ mode, error: 'Passwörter stimmen nicht überein.' }));
      const err = validatePassword(pw);
      if (err) return page(400, authPage({ mode, error: err }));
      succeed(ip);
      savePassword(pw);
      trustHost(host, proto);
      createSession(req, res, 'password');
      return res.redirect(302, '/');
    }

    const session = sessionFrom(req);
    if (req.path === '/logout') {
      if (session) { sessions.delete(session.id); persist(); }
      clearCookie(res);
      return res.redirect(302, '/');
    }
    if (!session || !hostTrusted(host)) {
      if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) return res.status(401).json({ error: 'Nicht angemeldet' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(401).end();
      return page(401, authPage({ mode: password() ? 'login' : 'setup', newHost: !hostTrusted(host) ? host : null }));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!originOk(req)) return res.status(403).json({ error: 'Ungültige Herkunft (Origin)' });
      if (req.headers['x-cockpit'] !== '1') return res.status(403).json({ error: 'Fehlender Header' });
    }
    req.cockpitSession = session;
    next();
  }

  /** WebSocket upgrade: trusted host, matching origin, valid session. Returns the session or null. */
  function verifyUpgrade(req) {
    if (!hostTrusted(requestHost(req)) || !originOk(req)) return null;
    return sessionFrom(req);
  }

  return {
    get token() { return token; },
    previewToken,
    middleware,
    verifyUpgrade,
    requestHost,
    isLocalRequest,
    hostOk: (req) => hostTrusted(requestHost(req)),
    hasPassword: () => !!password(),
    trustedOrigins: () => [...staticOrigins, ...learned.map((h) => h.origin)],
    setupCode: () => ensureSetupCode(),
    sessionValid: (id) => {
      const s = sessions.get(id);
      return !!s && s.rev === rev() && Date.now() - s.seen < SESSION_IDLE_MS;
    },

    /** Snapshot for the account dialog. */
    status(currentId) {
      return {
        hasPassword: !!password(),
        passwordAt: password()?.at ?? null,
        hosts: [...[...staticHosts].filter((h) => !isLocalHost(h)).map((h) => ({ host: h, fixed: true })), ...learned.map((h) => ({ host: h.host, origin: h.origin, addedAt: h.addedAt, fixed: false }))],
        sessions: [...sessions.entries()].filter(([, s]) => s.rev === rev())
          .map(([id, s]) => ({ id: id.slice(0, 16), via: s.via, ip: s.ip, host: s.host, ua: s.ua, created: s.created, seen: s.seen, current: id === currentId }))
          .sort((a, b) => b.seen - a.seen),
      };
    },

    /** Set or change the password from a signed-in session. Every other session is signed out. */
    setPassword({ password: pw, current, sessionId, ip }) {
      const rec = password();
      if (rec) {
        if (blocked(ip)) throw new UserError('Zu viele Versuche – eine Minute warten.');
        if (!verifyPassword(current ?? '', rec)) { fail(ip); throw new UserError('Aktuelles Passwort stimmt nicht.'); }
        succeed(ip);
      }
      const keep = sessions.get(sessionId);
      const newRev = savePassword(pw);
      for (const [id, s] of sessions) {
        if (id === sessionId && keep) s.rev = newRev;
        else sessions.delete(id);
      }
      persist();
    },

    revokeSession(prefix, currentId) {
      for (const id of sessions.keys()) if (id.startsWith(String(prefix)) && id !== currentId) sessions.delete(id);
      persist();
    },
    revokeOthers(currentId) {
      for (const id of sessions.keys()) if (id !== currentId) sessions.delete(id);
      persist();
    },
    removeHost(host) {
      learned = learned.filter((h) => h.host !== host);
      writeJson(hostsFile, { hosts: learned });
      for (const [id, s] of sessions) if (s.host === host) sessions.delete(id);
      persist();
    },
    /** New console link; the old one stops working (existing sessions stay). */
    rotateToken() {
      token = crypto.randomBytes(32).toString('base64url');
      fs.writeFileSync(tokenFile, token, { mode: 0o600 });
      return token;
    },
    flush() { if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; } persist(); },
  };
}

// ---- pages ------------------------------------------------------------------------
function authPage({ mode, error = null, newHost = null }) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const setup = mode === 'setup';
  const body = setup
    ? `<h1>Cockpit einrichten</h1>
<p>Lege das Passwort fest, das ab jetzt jeden Zugriff schützt – lokal, über Domain oder Tunnel. Den Einrichtungscode zeigt die Server-Konsole beim Start (oder <code>${cliCmd('link')}</code>).</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/setup">
<label>Einrichtungscode<input name="code" autocomplete="one-time-code" placeholder="XXXX-XXXX" autocapitalize="characters" required autofocus></label>
<label>Neues Passwort<input type="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></label>
<label>Wiederholen<input type="password" name="password2" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></label>
<button>Passwort setzen und anmelden</button></form>
<p class="small">Mindestens ${MIN_PASSWORD} Zeichen. Ein Passwortmanager-Passwort oder vier zufällige Wörter.</p>`
    : `<h1>Anmelden</h1>
${newHost ? `<p>Neue Adresse <code>${esc(newHost)}</code> – sie wird nach erfolgreicher Anmeldung freigegeben.</p>` : ''}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/login"><input type="password" name="password" autocomplete="current-password" placeholder="Passwort" autofocus required><button>Anmelden</button></form>`;
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Cockpit – ${setup ? 'Einrichten' : 'Anmelden'}</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15181a;color:#e7e5dd;font:15px/1.5 system-ui,sans-serif}
main{width:min(400px,92vw);padding:24px 0}.mark{display:flex;gap:10px;align-items:center;font:600 13px/1 system-ui;letter-spacing:.12em;text-transform:uppercase;margin-bottom:28px}
.mark i{width:4px;height:18px;background:#f0a73a;border-radius:2px}h1{font-weight:600;font-size:22px;letter-spacing:-.01em;margin:0 0 6px}
p{color:#a8aea9;margin:0 0 16px;font-size:14px}.small{font-size:12.5px;margin-top:14px}label{display:block;font-size:12.5px;color:#a8aea9;margin-bottom:10px}
input{display:block;width:100%;margin-top:4px;padding:11px 12px;border-radius:7px;border:1px solid #3a4146;background:#111416;color:#e7e5dd;font-size:16px}
input[name=code]{font-family:ui-monospace,Consolas,monospace;letter-spacing:.12em;text-transform:uppercase}
input:focus{outline:none;border-color:#f0a73a;box-shadow:0 0 0 3px rgba(240,167,58,.15)}button{margin-top:12px;width:100%;padding:11px;border:0;border-radius:7px;background:#f0a73a;color:#231603;font-weight:600;font-size:15px;cursor:pointer}
button:hover{background:#f6b552}.err{color:#e5695e}code{background:#21262a;padding:1px 5px;border-radius:4px;color:#e7e5dd}
</style><main><div class="mark"><i></i>Cockpit</div>${body}</main></html>`;
}
