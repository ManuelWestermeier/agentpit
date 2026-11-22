import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * CDP relay between a Claude session's Playwright MCP and the browser identity it currently uses.
 *
 * Every session gets one fixed endpoint (http://127.0.0.1:<port>/r/<token>). The relay decides on
 * each (re)connect which identity's browser is behind it and starts that browser on demand.
 * Switching identities = pointing the route elsewhere and dropping the open connections; Playwright
 * reconnects by itself on its next tool call – no MCP restart, works in the middle of a turn.
 */
export class CdpRelay {
  constructor() {
    this.routes = new Map(); // token → { resolve: async () => port, sockets: Set<WebSocket>, port }
    this.server = null;
    this.port = 0;
  }

  async start() {
    if (this.server) return;
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.server = http.createServer((req, res) => this.#http(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Browser nicht erreichbar: ${e.message}`);
    }));
    this.server.on('upgrade', (req, socket, head) => {
      const m = /^\/r\/([\w-]+)(\/devtools\/.+)$/.exec(req.url ?? '');
      const route = m && this.routes.get(m[1]);
      if (!route?.port) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (client) => this.#pipe(route, client, `ws://127.0.0.1:${route.port}${m[2]}`));
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
  }

  /** New route; `resolve` returns the CDP port of the browser to use (and starts it if needed). */
  add(resolve) {
    const token = crypto.randomBytes(18).toString('base64url');
    this.routes.set(token, { resolve, sockets: new Set(), port: null });
    return token;
  }

  endpoint(token) {
    return `http://127.0.0.1:${this.port}/r/${token}`;
  }

  /**
   * The route's target changed: drop connections so the next tool call reconnects to the new browser.
   * Hard close (no close handshake) – Playwright must notice at once, not after its next command
   * already went to the old browser. Resolves once the old connections are gone.
   */
  async retarget(token) {
    const route = this.routes.get(token);
    if (!route) return;
    route.port = null;
    for (const s of route.sockets) s.terminate();
    route.sockets.clear();
    await new Promise((r) => setTimeout(r, 250)); // let Playwright process the disconnect
  }

  remove(token) {
    const route = this.routes.get(token);
    for (const s of route?.sockets ?? []) s.terminate();
    this.routes.delete(token);
  }

  async stop() {
    for (const token of [...this.routes.keys()]) this.remove(token);
    await new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  async #http(req, res) {
    const m = /^\/r\/([\w-]+)\/json\/version\/?$/.exec(req.url ?? '');
    const route = m && this.routes.get(m[1]);
    if (!route) { res.writeHead(404).end(); return; }
    route.port = await route.resolve();
    const upstream = await fetch(`http://127.0.0.1:${route.port}/json/version`).then((r) => r.json());
    const browserPath = new URL(upstream.webSocketDebuggerUrl).pathname; // /devtools/browser/<id>
    upstream.webSocketDebuggerUrl = `ws://127.0.0.1:${this.port}/r/${m[1]}${browserPath}`;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(upstream));
  }

  #pipe(route, client, target) {
    const upstream = new WebSocket(target, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    const pending = [];
    route.sockets.add(client);
    const closeBoth = () => {
      route.sockets.delete(client);
      if (client.readyState <= 1) client.terminate();
      if (upstream.readyState <= 1) upstream.terminate();
    };
    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else pending.push([data, isBinary]);
    });
    upstream.on('open', () => { for (const [d, b] of pending.splice(0)) upstream.send(d, { binary: b }); });
    upstream.on('message', (data, isBinary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary }); });
    client.on('close', closeBoth);
    upstream.on('close', closeBoth);
    client.on('error', closeBoth);
    upstream.on('error', closeBoth);
  }
}
