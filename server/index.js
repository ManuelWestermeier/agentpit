import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createActions } from './actions.js';
import { Auth } from './auth.js';
import { Browsers } from './browsers.js';
import { CdpRelay } from './cdp-relay.js';
import { Databases } from './databases.js';
import { Installer } from './installer.js';
import { Janitor } from './janitor.js';
import { Meta } from './meta.js';
import { Schedules } from './schedules.js';
import { Git } from './git.js';
import { GitHub } from './github.js';
import { Services } from './services.js';
import { Catalog, Probe, UsagePoller } from './catalog.js';
import { ROOT, config } from './config.js';
import { checkEnvironment } from './environment.js';
import { Files } from './files.js';
import { Hub } from './hub.js';
import { Limits } from './limits.js';
import { Media } from './media.js';
import { Projects } from './projects.js';
import { Runners } from './runners.js';
import { createSecurity } from './security.js';
import { createAccess } from './access.js';
import { Monitor } from './monitor.js';
import { Tunnel } from './tunnel.js';
import { Audio } from './audio.js';
import { Sessions } from './sessions.js';
import { mountStatic } from './static.js';
import { Store, isProjectId } from './store.js';
import { Terminals } from './terminals.js';
import { UserError, safeEqual, throttle } from './util.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function portFree(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}
async function findPort(start, host, avoid = -1) {
  for (let p = start; p < start + 20; p++) if (p !== avoid && await portFree(p, host)) return p;
  throw new Error(`Kein freier Port ab ${start}`);
}

async function main() {
  const port = await findPort(config.port, config.host);
  const previewPort = await findPort(config.previewPort || port + 1, '127.0.0.1', port);
  const cfg = { ...config, port };

  const store = new Store(cfg.dataDir);
  await store.init();

  const ctx = { config: cfg, root: ROOT, store };
  ctx.hub = new Hub();
  ctx.media = new Media(store.p('media'));
  ctx.projects = new Projects(ctx);
  ctx.limits = new Limits(ctx);
  ctx.catalog = new Catalog(ctx);
  ctx.auth = new Auth(ctx);
  ctx.files = new Files(ctx);
  ctx.sessions = new Sessions(ctx);
  ctx.runners = new Runners(ctx);
  ctx.terminals = new Terminals(ctx);
  ctx.probe = new Probe(ctx);
  ctx.usagePoller = new UsagePoller(ctx);
  ctx.git = new Git(ctx);
  ctx.projects.git = ctx.git;
  ctx.github = new GitHub();
  ctx.browsers = new Browsers(ctx);
  ctx.relay = new CdpRelay();
  ctx.schedules = new Schedules(ctx);
  ctx.janitor = new Janitor(ctx);
  ctx.meta = new Meta(ctx);
  ctx.databases = new Databases(ctx);
  ctx.services = new Services(ctx);
  ctx.localUrl = `http://127.0.0.1:${port}`;
  ctx.monitor = new Monitor(ctx);
  ctx.tunnel = new Tunnel(ctx);
  ctx.audio = new Audio(ctx);

  if (process.env.COCKPIT_MOCK === '1') {
    // Development only: scripted fake sessions to exercise the UI without a Claude login.
    const { installMock } = await import('../test/mock-query.js');
    installMock(ctx);
    console.log('  MOCK-MODUS: keine echten Claude-Sessions');
  }

  const [env] = await Promise.all([
    checkEnvironment({ config: cfg, root: ROOT }),
    ctx.projects.init(),
    ctx.limits.load(),
    ctx.catalog.load(),
    ctx.terminals.init(),
  ]);
  ctx.env = env;
  ctx.checkEnv = () => checkEnvironment({ config: cfg, root: ROOT });
  ctx.installer = new Installer(ctx);
  await ctx.browsers.init();
  await ctx.relay.start();
  await ctx.schedules.init();
  ctx.janitor.start();
  const security = createSecurity({ config: cfg, port });
  ctx.security = security;
  ctx.access = createAccess(ctx);
  ctx.hub.filter = (client, msg) => ctx.access.filter(client, msg);
  const localPreview = `http://127.0.0.1:${previewPort}/p/${security.previewToken}`;
  // Remote clients: a second public origin if configured (PREVIEW_PUBLIC_URL), otherwise the sandboxed
  // same-origin route /p/… of the main server (works through any single tunnel).
  const previewBaseFor = (client) => (client?.local ? localPreview
    : cfg.previewPublicUrl ? `${cfg.previewPublicUrl}/p/${security.previewToken}` : `/p/${security.previewToken}`);
  // Close WebSockets whose session was signed out or invalidated by a password change.
  ctx.enforceSessions = () => {
    for (const c of ctx.hub.clients) if (!c.session || !security.sessionValid(c.session)) c.ws.close(4401, 'Abgemeldet');
  };
  setInterval(ctx.enforceSessions, 30_000).unref();

  ctx.helloPayload = async (client) => (client?.user ? {
    // browser user: their identities and nothing else
    version: VERSION,
    user: ctx.access.describe(client),
    config: { allowBypass: false, permissionModes: [], idleTimeoutMin: 0, maxRunners: 0, previewBase: '', terminals: false, remote: !client.local, hasPassword: true, autoCompactPct: 0 },
    browsers: { profiles: ctx.browsers.list({ hidden: true }).filter((p) => ctx.access.describe(client).browsers.includes(p.id)), status: {} },
    audio: await ctx.audio.status(),
    projects: [], runners: {}, schedules: [],
  } : {
    user: ctx.access.describe(client ?? {}),
    version: VERSION,
    config: {
      allowBypass: cfg.allowBypass,
      permissionModes: cfg.permissionModes,
      idleTimeoutMin: cfg.idleTimeoutMin,
      maxRunners: cfg.maxRunners,
      previewBase: previewBaseFor(client),
      terminals: ctx.terminals.available,
      remote: !client?.local,
      hasPassword: security.hasPassword(),
      autoCompactPct: cfg.autoCompactPct,
    },
    browsers: { profiles: ctx.browsers.list(), status: ctx.browsers.status() },
    github: ctx.github.snapshot(),
    env,
    auth: ctx.auth.snapshot(),
    catalog: ctx.catalog.snapshot(),
    limits: ctx.limits.snapshot(),
    projects: await ctx.projects.list(),
    runners: ctx.runners.snapshots(),
    schedules: ctx.schedules.list(),
    installs: ctx.installer.snapshot(),
    tunnel: ctx.tunnel.snapshot(),
    audio: await ctx.audio.status(),
    monitor: ctx.monitor.last,
  });

  // ---- broadcasts
  const { hub } = ctx;
  ctx.projects.on('change', throttle(async () => hub.toAll({ t: 'projects', projects: await ctx.projects.list() }), 300));
  ctx.schedules.on('change', throttle(() => hub.toAll({ t: 'schedules', schedules: ctx.schedules.list() }), 300));
  ctx.installer.on('change', throttle(() => hub.toAll({ t: 'env', env: ctx.env, installs: ctx.installer.snapshot() }), 300));
  ctx.auth.on('change', () => hub.toAll({ t: 'auth', auth: ctx.auth.snapshot() }));
  ctx.catalog.on('change', () => hub.toAll({ t: 'catalog', catalog: ctx.catalog.snapshot() }));
  ctx.limits.on('change', throttle(() => hub.toAll({ t: 'limits', limits: ctx.limits.snapshot() }), 500));
  hub.on('subs', (subs) => {
    for (const id of subs) ctx.files.watch(id);
    for (const id of [...ctx.files.watchers.keys()]) if (!subs.has(id)) ctx.files.unwatch(id);
  });
  ctx.github.on('change', () => hub.toAll({ t: 'github', github: ctx.github.snapshot() }));
  ctx.tunnel.on('change', throttle(() => hub.toAll({ t: 'tunnel', tunnel: ctx.tunnel.snapshot() }), 300));
  hub.on('connect', async (client) => hub.send(client, { t: 'hello', ...(await ctx.helloPayload(client)) }));
  hub.on('disconnect', (client) => { ctx.browsers.dropClient(client); ctx.audio.dropClient(client); });
  // binary frame: [1 = mic][id length][id][PCM s16le mono] – only for identities this client may use
  hub.binary = (client, buf) => {
    if (!Buffer.isBuffer(buf) || buf.length < 3 || buf[0] !== 1) return;
    const n = buf[1];
    const id = buf.toString('utf8', 2, 2 + n);
    if (!ctx.access.canUseBrowser(client.user ? { user: client.user } : { id: client.session }, id)) return;
    ctx.audio.micData(id, client, buf.subarray(2 + n));
  };
  hub.onMessage(createActions(ctx));

  // ---- main app (UI, API, WebSocket)
  const app = express();
  app.disable('x-powered-by');
  let mainPreview = (_req, res) => res.status(503).end();
  app.set('query parser', 'simple');

  // Hook API: services and scripts send prompts into a project's session.
  // Auth: per-project bearer token (no cookies), so cross-origin calls are safe to allow.
  const hookHits = new Map();
  app.use('/api/hook', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!security.hostOk(req)) return res.status(421).end();
    next();
  });
  app.all('/api/hook/:projectId', express.json({ limit: '100kb' }), async (req, res) => {
    try {
      const project = await ctx.projects.get(req.params.projectId);
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!project.hookToken || !safeEqual(bearer, project.hookToken)) return res.status(401).json({ error: 'Token ungültig' });
      const runner = await ctx.runners.get(project.id);
      if (req.method === 'GET') return res.json({ state: runner.state, sessionId: runner.sessionId });
      if (req.method !== 'POST') return res.status(405).end();
      const last = hookHits.get(project.id) ?? 0;
      if (Date.now() - last < 2000) return res.status(429).json({ error: 'Zu schnell – max. eine Nachricht alle 2 s' });
      hookHits.set(project.id, Date.now());
      const text = String(req.body?.text ?? '').trim();
      if (!text) return res.status(400).json({ error: 'text fehlt' });
      const from = String(req.body?.from ?? 'Dienst').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40) || 'Dienst';
      await runner.send(`[Nachricht von ${from}]\n${text.slice(0, 50_000)}`, { source: from });
      res.json({ ok: true, queued: runner.state === 'running' || runner.state === 'waiting' });
    } catch (e) {
      res.status(e.user ? 400 : 500).json({ error: e.message });
    }
  });

  // Preview through the main origin (remote access without a second public port), token-protected and sandboxed.
  app.get('/p/:token/:projectId/*rest', (req, res) => mainPreview(req, res));

  app.use(security.middleware);

  app.post('/api/projects/:id/upload', async (req, res) => {
    try {
      if (!isProjectId(req.params.id)) return res.status(400).json({ error: 'Ungültige Projekt-ID' });
      const rel = await ctx.files.saveUploadStream(req.params.id, req.query.name, req, 2 * 1024 ** 3);
      res.json({ path: rel });
    } catch (e) {
      if (!res.headersSent) res.status(e.user ? 400 : 500).json({ error: e.message });
    }
  });

  // file for a remote browser's file chooser (Page.fileChooserOpened → viewer picks → upload → setFileInputFiles)
  app.post('/api/browsers/:id/upload', async (req, res) => {
    try {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(req.params.id)) return res.status(400).json({ error: 'Ungültige ID' });
      if (!ctx.access.canUseBrowser(req.cockpitSession, req.params.id)) return res.status(403).json({ error: 'Kein Zugriff' });
      const { file, abs } = await ctx.browsers.uploadPath(req.params.id, req.query.name);
      let size = 0;
      const max = 512 * 1024 ** 2;
      await pipeline(req, new Transform({ transform(c, _e, cb) { size += c.length; cb(size > max ? new UserError('Datei zu groß (max. 512 MB)') : null, c); } }), fs.createWriteStream(abs, { flags: 'wx' }))
        .catch(async (e) => { await fs.promises.rm(abs, { force: true }); throw e; });
      res.json({ file });
    } catch (e) {
      if (!res.headersSent) res.status(e.user ? 400 : 500).json({ error: e.message });
    }
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, version: VERSION }));

  if (!mountStatic(app, { webDist: cfg.webDist, mediaDir: store.p('media'), hasUi: fs.existsSync(path.join(cfg.webDist, 'index.html')) })) {
    app.get('/', (_req, res) => res.type('text/plain').send('Web-UI nicht gebaut: npm run build:web'));
  }

  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    const session = new URL(req.url, 'http://x').pathname === '/ws' ? security.verifyUpgrade(req) : null;
    if (!session) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    req.cockpitSession = session;
    req.cockpitHost = security.requestHost(req);
    req.cockpitLocal = security.isLocalRequest(req);
    req.cockpitIp = req.socket.remoteAddress;
    hub.handleUpgrade(req, socket, head);
  });

  // ---- preview server: project files on a separate origin, so generated HTML
  //      cannot read the cockpit's cookie or call its API.
  const preview = express();
  preview.disable('x-powered-by');
  const previewHosts = new Set([`127.0.0.1:${previewPort}`, `localhost:${previewPort}`]);
  if (cfg.previewPublicUrl) previewHosts.add(new URL(cfg.previewPublicUrl).host.toLowerCase());
  const uiOrigins = () => new Set(security.trustedOrigins()); // includes addresses learned at login
  const servePreview = (sameOrigin) => async (req, res) => {
    if (req.params.token !== security.previewToken) return res.status(404).end();
    if (sameOrigin ? !security.hostOk(req) : !previewHosts.has(security.requestHost(req))) return res.status(404).end();
    try {
      const rel = [].concat(req.params.rest ?? []).join('/');
      const { abs } = await ctx.files.resolve(req.params.projectId, rel);
      if (sameOrigin) {
        // Same origin as the UI: the sandbox makes generated HTML an opaque origin – no cookies, no API, no storage.
        res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-presentation; frame-ancestors 'self'");
      } else {
        // The UI fetches text files for its viewer; only the cockpit origins may read responses.
        const origin = req.headers.origin;
        const origins = uiOrigins();
        if (typeof origin === 'string' && origins.has(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
        }
        res.setHeader('Content-Security-Policy', `frame-ancestors ${[...origins].join(' ')}`);
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(abs, { dotfiles: 'allow' }, (err) => { if (err && !res.headersSent) res.status(err.statusCode || 404).end(); });
    } catch (e) {
      res.status(e.user ? 403 : 500).type('text/plain').send(e.message);
    }
  };
  preview.get('/p/:token/:projectId/*rest', servePreview(false));
  mainPreview = servePreview(true);
  const previewServer = http.createServer(preview);

  await new Promise((resolve) => server.listen(port, cfg.host, resolve));
  await new Promise((resolve) => previewServer.listen(previewPort, '127.0.0.1', resolve));

  ctx.usagePoller.start();
  ctx.monitor.start();
  // TUNNEL=quick | token (or --tunnel): remote access through Cloudflare right away
  if (/^(1|true|yes|on|quick|token|cloudflare)$/i.test(process.env.TUNNEL ?? '')) {
    ctx.tunnel.start(/^token$/i.test(process.env.TUNNEL) || process.env.CLOUDFLARE_TUNNEL_TOKEN ? 'token' : 'quick')
      .catch((e) => console.warn(`  Tunnel: ${e.message}`));
  }
  ctx.github.refresh().catch(() => {});
  for (const p of await ctx.projects.list()) ctx.services.autostart(p.id).catch(() => {});
  ctx.auth.refresh().then((s) => {
    console.log(`  Claude-Login: ${s.loggedIn ? `${s.authMethod}${s.email ? ` (${s.email})` : ''}` : 'nicht angemeldet – im Cockpit einloggen'}`);
    if (s.loggedIn) ctx.probe.run({ usage: true }).then((r) => r.usage && ctx.limits.ingestUsage(r.usage)).catch(() => {});
  });

  const url = `http://localhost:${port}/?token=${security.token}`;
  // console in English unless the system runs in German
  const de = /^de\b/i.test(process.env.LC_ALL || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || '');
  const L = (deText, enText) => (de ? deText : enText);
  console.log(`\n  agentpit ${VERSION}`);
  if (cfg.home !== ROOT) console.log(`  ${L('Daten', 'Data')}: ${cfg.home}`);
  console.log(`  ${url}`);
  if (!security.hasPassword()) {
    console.log(`  ${L('Ersteinrichtung: Passwort im Browser festlegen – Einrichtungscode', 'First run: set a password in the browser – setup code')} ${security.setupCode()}`);
  }
  for (const u of cfg.publicUrls) console.log(`  ${L('Fernzugriff', 'Remote access')}: ${u}`);
  console.log(`  ${L('Projekte', 'Projects')}: ${cfg.projectsDir}`);
  console.log(`  Claude Code ${env.claude.version ?? '?'}${env.claude.bundled ? L(' (aus dem SDK)', ' (bundled)') : ''} · ffmpeg ${env.ffmpeg ?? L('fehlt', 'missing')} · Browser ${env.browser.channel || L('keiner', 'none')} · Terminal ${env.pty ? L('ja', 'yes') : L('nein', 'no')}`);
  if (de) for (const h of env.hints) console.log(`  Hinweis: ${h.text}  →  ${h.cmd}`);
  else for (const h of env.hints) console.log(`  Hint: ${h.key} missing  →  ${h.cmd}`);
  if (port !== config.port) console.log(`  (${L(`Port ${config.port} war belegt, nutze ${port}`, `port ${config.port} was busy, using ${port}`)})`);

  if (cfg.openBrowser) {
    import('open').then(({ default: open }) => open(url)).catch((e) => console.warn(`  Browser konnte nicht geöffnet werden: ${e.message}`));
  }

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n  ${sig}: beende Sessions …`);
    const force = setTimeout(() => process.exit(1), 8000);
    force.unref();
    ctx.usagePoller.stop();
    ctx.monitor.stop();
    ctx.tunnel.stop();
    ctx.audio.stopAll();
    ctx.schedules.stop();
    ctx.janitor.stop();
    ctx.auth.cancelLogin('Server beendet');
    ctx.github.cancel();
    await ctx.services.stopAll().catch(() => {});
    await ctx.browsers.stopAll().catch(() => {});
    ctx.terminals.closeAll();
    ctx.files.closeAll();
    await ctx.runners.shutdown().catch(() => {});
    await ctx.relay.stop().catch(() => {});
    hub.close();
    security.flush();
    await store.flush();
    server.close();
    previewServer.close();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    try { process.on(sig, () => shutdown(sig)); } catch { /* signal not supported on this platform */ }
  }
}

// A failing background task (browser tab closed mid-call, network hiccup) must not take down every session.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (w, ...rest) => { if (!String(w?.message ?? w).includes('SQLite is an experimental')) emitWarning(w, ...rest); };
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message ?? e));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
