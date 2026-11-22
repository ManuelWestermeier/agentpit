import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

const MAX_BUFFERED = 8 * 1024 * 1024;

/** WebSocket fan-out. Clients subscribe to the projects they show; status goes to everyone. */
export class Hub extends EventEmitter {
  constructor() {
    super();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    this.clients = new Set();
    this.handler = null;
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) { c.ws.terminate(); continue; }
        c.alive = false;
        try { c.ws.ping(); } catch { /* closing */ }
      }
    }, 30_000);
    this.heartbeat.unref?.();
  }

  onMessage(handler) { this.handler = handler; }

  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.#attach(ws));
  }

  #attach(ws) {
    const client = { ws, subs: new Set(), alive: true };
    this.clients.add(client);
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      const reply = (payload) => this.send(client, { t: 'ack', reqId: msg.reqId ?? null, ...payload });
      try {
        const data = await this.handler?.(msg, client);
        if (msg.reqId != null) reply({ ok: true, data: data ?? null });
      } catch (e) {
        if (!e.user) console.error(`[ws] ${msg.t}:`, e);
        reply({ ok: false, error: e.user ? e.message : `Fehler: ${e.message}` });
      }
    });
    ws.on('close', () => {
      this.clients.delete(client);
      this.emit('subs', this.subscribedProjects());
      this.emit('disconnect', client);
    });
    ws.on('error', () => {});
    this.emit('connect', client);
  }

  subscribe(client, projectIds) {
    client.subs = new Set(projectIds);
    this.emit('subs', this.subscribedProjects());
  }

  subscribedProjects() {
    const s = new Set();
    for (const c of this.clients) for (const p of c.subs) s.add(p);
    return s;
  }

  clientCount() { return this.clients.size; }

  send(client, obj) {
    const ws = client.ws;
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED && obj.t === 'live') return; // drop stream frames under backpressure
    ws.send(JSON.stringify(obj));
  }

  toAll(obj) {
    if (!this.clients.size) return;
    const s = JSON.stringify(obj);
    for (const c of this.clients) {
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(s);
    }
  }

  toProject(projectId, obj) {
    let s = null;
    for (const c of this.clients) {
      if (!c.subs.has(projectId) || c.ws.readyState !== c.ws.OPEN) continue;
      if (obj.t === 'live' && c.ws.bufferedAmount > MAX_BUFFERED) continue;
      s ??= JSON.stringify(obj);
      c.ws.send(s);
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.ws.close(1001, 'Server beendet');
    this.wss.close();
  }
}
