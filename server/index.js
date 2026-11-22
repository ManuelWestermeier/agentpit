import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createActions } from './actions.js';
import { Auth } from './auth.js';
import { Catalog, Probe, UsagePoller } from './catalog.js';
import { ROOT, config } from './config.js';
import { checkEnvironment } from './environment.js';
import { Files } from './files.js';
import { Hub } from './hub.js';
import { Limits } from './limits.js';
import { MEDIA_NAME_RE, Media } from './media.js';
import { Projects } from './projects.js';
import { Runners } from './runners.js';
import { createSecurity } from './security.js';
import { Sessions } from './sessions.js';
import { Store, isProjectId } from './store.js';
import { Terminals } from './terminals.js';
import { throttle } from './util.js';

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
  const security = createSecurity({ config: cfg });
  const previewBase = `http://127.0.0.1:${previewPort}/p/${security.previewToken}`;

  ctx.helloPayload = async () => ({
    version: VERSION,
    config: {
      allowBypass: cfg.allowBypass,
      permissionModes: cfg.permissionModes,
      idleTimeoutMin: cfg.idleTimeoutMin,
      maxRunners: cfg.maxRunners,
      previewBase,
      terminals: ctx.terminals.available,
    },
    env,
    auth: ctx.auth.snapshot(),
    catalog: ctx.catalog.snapshot(),
    limits: ctx.limits.snapshot(),
    projects: await ctx.projects.list(),
    runners: ctx.runners.snapshots(),
  });

  // ---- broadcasts
  const { hub } = ctx;
  ctx.projects.on('change', throttle(async () => hub.toAll({ t: 'projects', projects: await ctx.projects.list() }), 300));
  ctx.auth.on('change', () => hub.toAll({ t: 'auth', auth: ctx.auth.snapshot() }));
  ctx.catalog.on('change', () => hub.toAll({ t: 'catalog', catalog: ctx.catalog.snapshot() }));
  ctx.limits.on('change', throttle(() => hub.toAll({ t: 'limits', limits: ctx.limits.snapshot() }), 500));
  hub.on('subs', (subs) => {
    for (const id of subs) ctx.files.watch(id);
    for (const id of [...ctx.files.watchers.keys()]) if (!subs.has(id)) ctx.files.unwatch(id);
  });
  hub.on('connect', async (client) => hub.send(client, { t: 'hello', ...(await ctx.helloPayload()) }));
  hub.onMessage(createActions(ctx));

  // ---- main app (UI, API, WebSocket)
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use(security.middleware);

  app.get('/media/:name', (req, res) => {
    if (!MEDIA_NAME_RE.test(req.params.name)) return res.status(404).end();
    res.sendFile(path.join(store.p('media'), req.params.name), { maxAge: '30d', immutable: true });
  });

  app.post('/api/projects/:id/upload', async (req, res) => {
    try {
      if (!isProjectId(req.params.id)) return res.status(400).json({ error: 'Ungültige Projekt-ID' });
      const rel = await ctx.files.saveUploadStream(req.params.id, req.query.name, req, 2 * 1024 ** 3);
      res.json({ path: rel });
    } catch (e) {
      if (!res.headersSent) res.status(e.user ? 400 : 500).json({ error: e.message });
    }
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, version: VERSION }));

  if (fs.existsSync(path.join(cfg.webDist, 'index.html'))) {
    app.use(express.static(cfg.webDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/|media\/).*/, (_req, res) => res.sendFile(path.join(cfg.webDist, 'index.html')));
  } else {
    app.get('/', (_req, res) => res.type('text/plain').send('Web-UI nicht gebaut: npm run build:web'));
  }

  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws' || !security.verifyUpgrade(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    hub.handleUpgrade(req, socket, head);
  });

  // ---- preview server: project files on a separate origin, so generated HTML
  //      cannot read the cockpit's cookie or call its API.
  const preview = express();
  preview.disable('x-powered-by');
  const previewHosts = new Set([`127.0.0.1:${previewPort}`, `localhost:${previewPort}`]);
  const uiOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, ...cfg.devOrigins]);
  const frameAncestors = [...uiOrigins].join(' ');
  preview.get('/p/:token/:projectId/*rest', async (req, res) => {
    if (!previewHosts.has(String(req.headers.host)) || req.params.token !== security.previewToken) return res.status(404).end();
    try {
      const rel = [].concat(req.params.rest ?? []).join('/');
      const { abs } = await ctx.files.resolve(req.params.projectId, rel);
      // The UI fetches text files for its viewer; only the cockpit origins may read responses.
      const origin = req.headers.origin;
      if (typeof origin === 'string' && uiOrigins.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(abs, { dotfiles: 'allow' }, (err) => { if (err && !res.headersSent) res.status(err.statusCode || 404).end(); });
    } catch (e) {
      res.status(e.user ? 403 : 500).type('text/plain').send(e.message);
    }
  });
  const previewServer = http.createServer(preview);

  await new Promise((resolve) => server.listen(port, cfg.host, resolve));
  await new Promise((resolve) => previewServer.listen(previewPort, '127.0.0.1', resolve));

  ctx.usagePoller.start();
  ctx.auth.refresh().then((s) => {
    console.log(`  Claude-Login: ${s.loggedIn ? `${s.authMethod}${s.email ? ` (${s.email})` : ''}` : 'nicht angemeldet – im Cockpit einloggen'}`);
    if (s.loggedIn) ctx.probe.run({ usage: true }).then((r) => r.usage && ctx.limits.ingestUsage(r.usage)).catch(() => {});
  });

  const url = `http://localhost:${port}/?token=${security.token}`;
  console.log(`\n  Agent Cockpit ${VERSION}`);
  console.log(`  ${url}`);
  console.log(`  Projekte: ${cfg.projectsDir}`);
  console.log(`  Claude Code ${env.claude.version ?? '?'}${env.claude.bundled ? ' (aus dem SDK)' : ''} · ffmpeg ${env.ffmpeg ?? 'fehlt'} · Browser ${env.browser.channel || 'keiner'} · Terminal ${env.pty ? 'ja' : 'nein'}`);
  for (const h of env.hints) console.log(`  Hinweis: ${h.text}  →  ${h.cmd}`);
  if (port !== config.port) console.log(`  (Port ${config.port} war belegt, nutze ${port})`);

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
    ctx.auth.cancelLogin('Server beendet');
    ctx.terminals.closeAll();
    ctx.files.closeAll();
    await ctx.runners.shutdown().catch(() => {});
    hub.close();
    await store.flush();
    server.close();
    previewServer.close();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    try { process.on(sig, () => shutdown(sig)); } catch { /* signal not supported on this platform */ }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
