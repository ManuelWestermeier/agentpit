import crypto from 'node:crypto';

export const uuid = () => crypto.randomUUID();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

// ESC/CSI/OSC sequences (colors, cursor movement, hyperlinks)
const ANSI_RE = /[\u001b\u009b](?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])/g;
export const stripAnsi = (s) => String(s ?? '').replace(ANSI_RE, '');

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  wrapped.flush = (...args) => { clearTimeout(t); t = null; fn(...args); };
  return wrapped;
}

/** Leading + trailing throttle. */
export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pendingArgs = null;
  return (...args) => {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      fn(...args);
    } else {
      pendingArgs = args;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          fn(...pendingArgs);
        }, wait);
      }
    }
  };
}

export function withTimeout(promise, ms, label = 'Operation') {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label}: Zeitüberschreitung nach ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

export function slugify(name) {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return s || 'projekt';
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Errors whose message is safe and meant for the UI. */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
    this.user = true;
  }
}

/**
 * Push-based async iterable used as the SDK's streaming input.
 * The SDK pulls user messages from it for the lifetime of the session.
 */
export class AsyncQueue {
  #items = [];
  #waiters = [];
  #closed = false;

  push(item) {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
    return true;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }

  get closed() { return this.#closed; }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#items.length) return Promise.resolve({ value: this.#items.shift(), done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** Keeps the last `max` chars of text output. */
export class TailBuffer {
  constructor(max = 64_000) { this.max = max; this.text = ''; }
  push(chunk) {
    this.text += chunk;
    if (this.text.length > this.max) this.text = this.text.slice(this.text.length - this.max);
  }
  toString() { return this.text; }
}
