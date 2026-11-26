type Listener = (msg: any) => void;

/** Single WebSocket with automatic reconnect and request/ack correlation. */
class Connection {
  private ws: WebSocket | null = null;
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>();
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(up: boolean) => void>();
  private backoff = 500;
  private queue: string[] = [];
  up = false;

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.setUp(true);
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (e) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'ack' && msg.reqId != null) {
        const w = this.waiting.get(msg.reqId);
        if (w) {
          this.waiting.delete(msg.reqId);
          clearTimeout(w.timer);
          if (msg.ok) w.resolve(msg.data);
          else w.reject(new Error(msg.error || 'Fehler'));
        }
        return;
      }
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = (ev) => {
      this.setUp(false);
      // Signed out elsewhere, password changed or session expired → show the login page
      fetch('/api/health', { credentials: 'same-origin', cache: 'no-store' })
        .then((r) => { if (r.status === 401) location.reload(); })
        .catch(() => {});
      if (ev.code === 4401) return;
      for (const [id, w] of this.waiting) { clearTimeout(w.timer); w.reject(new Error('Verbindung getrennt')); this.waiting.delete(id); }
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };
  }

  private setUp(v: boolean) {
    this.up = v;
    for (const l of this.statusListeners) l(v);
  }

  onMessage(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  onStatus(l: (up: boolean) => void) { this.statusListeners.add(l); return () => this.statusListeners.delete(l); }

  /** Binary frame (microphone audio); dropped while offline or when the socket is backed up. */
  sendBinary(data: ArrayBuffer | Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN && this.ws.bufferedAmount < 256 * 1024) this.ws.send(data);
  }

  /** Fire-and-forget. */
  send(t: string, payload: Record<string, unknown> = {}) {
    const s = JSON.stringify({ t, ...payload });
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.queue.push(s);
  }

  /** Request with ack; rejects with the server's (German) error message. */
  call<T = any>(t: string, payload: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    const reqId = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.waiting.delete(reqId);
        reject(new Error('Zeitüberschreitung'));
      }, timeoutMs);
      this.waiting.set(reqId, { resolve, reject, timer });
      this.send(t, { ...payload, reqId });
    });
  }
}

export const conn = new Connection();
