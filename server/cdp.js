import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

/**
 * Minimal Chrome DevTools Protocol client with flat sessions.
 *
 * Why not Playwright for the cockpit's own connection: Playwright attaches to every tab and turns on
 * `Runtime.enable` there. Pages can notice that (console serialisation side effects), and anti-bot
 * scripts (TikTok, Instagram, Cloudflare) react with blocked logins or frozen pages. This client only
 * uses domains that leave no trace in the page: Target, Page, Input, Emulation, Browser, Storage, FedCm.
 * It never enables Runtime or Debugger.
 */
export class Cdp extends EventEmitter {
  static async connect(wsUrl, timeoutMs = 10_000) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { ws.terminate(); reject(new Error('CDP: Zeitüberschreitung beim Verbinden')); }, timeoutMs);
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    super();
    this.setMaxListeners(0);
    this.ws = ws;
    this.nextId = 1;
    this.calls = new Map();
    this.closed = false;
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.id != null) {
        const c = this.calls.get(m.id);
        if (!c) return;
        this.calls.delete(m.id);
        clearTimeout(c.timer);
        if (m.error) c.reject(Object.assign(new Error(`${c.method}: ${m.error.message}`), { code: m.error.code }));
        else c.resolve(m.result ?? {});
        return;
      }
      if (m.method) this.emit(m.method, m.params ?? {}, m.sessionId ?? null);
    });
    const onClose = () => {
      if (this.closed) return;
      this.closed = true;
      for (const c of this.calls.values()) { clearTimeout(c.timer); c.reject(new Error('CDP-Verbindung geschlossen')); }
      this.calls.clear();
      this.emit('disconnected');
    };
    ws.on('close', onClose);
    ws.on('error', onClose);
  }

  /** One command; `sessionId` targets an attached tab. Rejects after `timeoutMs` (0 = never). */
  send(method, params = {}, sessionId = null, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error('CDP-Verbindung geschlossen'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        if (this.calls.delete(id)) reject(Object.assign(new Error(`${method}: keine Antwort nach ${timeoutMs} ms`), { timeout: true }));
      }, timeoutMs) : null;
      this.calls.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  /** Attach to a target (flat session); returns the sessionId. */
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  detach(sessionId) {
    return this.send('Target.detachFromTarget', { sessionId }, null, 5000).catch(() => {});
  }

  close() {
    try { this.ws.close(); } catch { /* gone */ }
  }
}

export async function cdpVersion(port, timeoutMs = 3000) {
  const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`CDP ${r.status}`);
  return r.json();
}
