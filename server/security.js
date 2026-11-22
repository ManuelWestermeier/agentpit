import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeEqual } from './util.js';

const COOKIE = 'cockpit';

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

/**
 * Local-only access control:
 *  - Host header must be a loopback name on our port (blocks DNS rebinding)
 *  - Session cookie (HttpOnly, SameSite=Strict) obtained via the one-time link printed on start
 *  - Origin must match for WebSocket upgrades and every non-GET request (blocks CSRF / cross-site WS)
 */
export function createSecurity({ config }) {
  const token = loadOrCreateToken(path.join(config.dataDir, '.token'));
  const previewToken = crypto.randomBytes(18).toString('base64url');

  const port = config.port;
  const hostNames = ['localhost', '127.0.0.1', '[::1]'];
  const allowedHosts = new Set(hostNames.map((h) => `${h}:${port}`));
  const allowedOrigins = new Set(hostNames.map((h) => `http://${h}:${port}`));
  for (const o of config.devOrigins) {
    try {
      const u = new URL(o);
      allowedOrigins.add(u.origin);
      allowedHosts.add(u.host);
    } catch { console.warn(`[security] DEV_ORIGINS: ungültiger Eintrag ${o}`); }
  }

  const hasValidCookie = (req) => safeEqual(parseCookies(req.headers.cookie)[COOKIE], token);
  const hostOk = (req) => allowedHosts.has(String(req.headers.host ?? '').toLowerCase());
  const originOk = (req) => {
    const origin = req.headers.origin;
    return typeof origin === 'string' && allowedOrigins.has(origin);
  };

  function middleware(req, res, next) {
    if (!hostOk(req)) return res.status(421).type('text/plain').send('Ungültiger Host.');
    // One-time login link: /?token=...
    if (req.method === 'GET' && typeof req.query.token === 'string') {
      if (safeEqual(req.query.token, token)) {
        res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
        return res.redirect(302, '/');
      }
      return res.status(403).type('text/plain').send('Ungültiger Zugangslink.');
    }
    if (!hasValidCookie(req)) {
      if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) return res.status(401).json({ error: 'Nicht angemeldet' });
      return res.status(401).type('html').send(LOCKED_PAGE);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!originOk(req)) return res.status(403).json({ error: 'Ungültige Herkunft (Origin)' });
      if (req.headers['x-cockpit'] !== '1') return res.status(403).json({ error: 'Fehlender Header' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  }

  function verifyUpgrade(req) {
    return hostOk(req) && originOk(req) && hasValidCookie(req);
  }

  return { token, previewToken, middleware, verifyUpgrade };
}

const LOCKED_PAGE = `<!doctype html><html lang="de"><meta charset="utf-8"><title>Cockpit gesperrt</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#16191b;color:#e6e4dc;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:34rem;padding:2rem}code{background:#252a2e;padding:.1em .4em;border-radius:4px}</style>
<main><h1 style="font-weight:500">Kein Zugang</h1><p>Öffne das Cockpit über den Link, den der Server beim Start in der Konsole ausgibt
(<code>http://localhost:PORT/?token=…</code>). Der Link setzt ein Cookie nur für diesen Browser.</p></main></html>`;
