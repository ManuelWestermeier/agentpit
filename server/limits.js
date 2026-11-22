import { EventEmitter } from 'node:events';

const DAY = 24 * 3600_000;
const sameWindow = (a, b) => a != null && b != null && Math.abs(a - b) < 5 * 60_000;
const toMs = (iso) => {
  if (iso == null) return null;
  if (typeof iso === 'number') return iso < 1e12 ? iso * 1000 : iso;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** Least-squares slope of utilization (%) over time (ms). */
function slope(points) {
  const n = points.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  const t0 = points[0].t;
  for (const p of points) {
    const x = p.t - t0;
    sx += x; sy += p.u; sxx += x * x; sxy += x * p.u;
  }
  const den = n * sxx - sx * sx;
  return den > 0 ? (n * sxy - sx * sy) / den : 0;
}

/**
 * Claude plan limits (5-hour / weekly windows) from the SDK's usage call, plus a
 * forecast: burn rate from recent samples, ETA of 100 %, and %-of-limit per USD
 * (API-equivalent cost) measured on this machine.
 */
export class Limits extends EventEmitter {
  constructor({ store }) {
    super();
    this.store = store;
    this.file = store.p('limits.json');
    this.state = { available: null, subscription: null, windows: {}, modelScoped: [], extra: null, at: 0, warning: null };
    this.samples = [];
    this.costTotal = 0;      // cumulative USD (API-equivalent) of all cockpit sessions
    this.lastActivity = 0;   // last model call in any cockpit session
    this.persistTimer = null;
  }

  async load() {
    const d = await this.store.readJson(this.file, null);
    if (!d) return;
    this.samples = Array.isArray(d.samples) ? d.samples.filter((s) => s.t > Date.now() - 8 * DAY) : [];
    if (d.state) this.state = { ...this.state, ...d.state, warning: null };
    this.costTotal = Number(d.costTotal) || 0;
    this.lastActivity = Number(d.lastActivity) || 0;
  }

  #persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.store.writeJson(this.file, { state: this.state, samples: this.samples, costTotal: this.costTotal, lastActivity: this.lastActivity });
    }, 1500);
  }

  addCost(delta) {
    if (delta > 0) this.costTotal += delta;
    this.lastActivity = Date.now();
    this.#persist();
  }

  /** Response of query.usage_EXPERIMENTAL_…() — utilization in percent, resets_at ISO. */
  ingestUsage(resp) {
    if (!resp || typeof resp !== 'object') return;
    this.state.available = !!resp.rate_limits_available;
    this.state.subscription = resp.subscription_type ?? null;
    const rl = resp.rate_limits;
    if (rl) {
      const win = (o) => (o && typeof o.utilization === 'number' ? { u: o.utilization, resetsAt: toMs(o.resets_at) } : null);
      this.state.windows = {
        five_hour: win(rl.five_hour),
        seven_day: win(rl.seven_day),
        seven_day_opus: win(rl.seven_day_opus),
        seven_day_sonnet: win(rl.seven_day_sonnet),
      };
      this.state.modelScoped = (rl.model_scoped ?? [])
        .filter((m) => typeof m?.utilization === 'number')
        .map((m) => ({ name: String(m.display_name ?? 'Modell'), u: m.utilization, resetsAt: toMs(m.resets_at) }));
      this.state.extra = rl.extra_usage ?? null;
    } else {
      this.state.windows = {};
      this.state.modelScoped = [];
    }
    this.state.at = Date.now();
    const w5 = this.state.windows.five_hour, w7 = this.state.windows.seven_day;
    if (w5 || w7) {
      this.samples.push({ t: Date.now(), u5: w5?.u ?? null, r5: w5?.resetsAt ?? null, u7: w7?.u ?? null, r7: w7?.resetsAt ?? null, c: this.costTotal });
      const cutoff = Date.now() - 8 * DAY;
      while (this.samples.length && (this.samples[0].t < cutoff || this.samples.length > 4000)) this.samples.shift();
    }
    this.#persist();
    this.emit('change');
  }

  /**
   * rate_limit_event from the stream. The docs leave units open, so it is used for the
   * warning status; numbers only fill in when the usage call is unavailable.
   */
  ingestEvent(info) {
    if (!info) return;
    const resetsAt = toMs(info.resetsAt);
    let u = typeof info.utilization === 'number' ? info.utilization : null;
    if (u != null && u <= 1) u *= 100; // header-style fraction
    this.state.warning = info.status === 'allowed'
      ? null
      : { status: info.status, type: info.rateLimitType ?? null, resetsAt, utilization: u, errorCode: info.errorCode ?? null, at: Date.now() };
    if (this.state.available !== true && info.rateLimitType && u != null) {
      this.state.windows = { ...this.state.windows, [info.rateLimitType]: { u, resetsAt, approx: true } };
    }
    this.emit('change');
  }

  forecast() {
    const now = Date.now();
    const out = {};
    const defs = [['five_hour', 'u5', 'r5', 90 * 60_000], ['seven_day', 'u7', 'r7', DAY]];
    for (const [key, uk, rk, horizon] of defs) {
      const cur = this.state.windows[key];
      if (!cur) continue;
      const pts = this.samples
        .filter((s) => s[uk] != null && sameWindow(s[rk], cur.resetsAt) && s.t >= now - horizon)
        .map((s) => ({ t: s.t, u: s[uk] }));
      const span = pts.length ? pts[pts.length - 1].t - pts[0].t : 0;
      const k = pts.length >= 2 && span >= 4 * 60_000 ? slope(pts) : 0; // % per ms
      const perHour = k * 3600_000;
      let eta = null;
      if (k > 0 && cur.u < 100) eta = now + (100 - cur.u) / k;
      out[key] = {
        perHour,
        eta,
        hitsBeforeReset: eta != null && cur.resetsAt ? eta < cur.resetsAt : false,
        basis: pts.length,
      };
    }
    // How much of the 5-hour window one USD of API-equivalent cost consumes here
    let du = 0, dc = 0;
    for (let i = 1; i < this.samples.length; i++) {
      const a = this.samples[i - 1], b = this.samples[i];
      if (b.t < now - DAY || a.u5 == null || b.u5 == null || !sameWindow(a.r5, b.r5)) continue;
      const c = b.c - a.c;
      if (c > 0.0005 && b.u5 >= a.u5) { du += b.u5 - a.u5; dc += c; }
    }
    out.pctPerUsd5h = dc >= 0.05 ? du / dc : null;
    return out;
  }

  /** Samples of the current window, thinned to at most `max` points. */
  #series(uk, rk, key, max) {
    const cur = this.state.windows[key];
    if (!cur) return [];
    const pts = this.samples.filter((s) => s[uk] != null && sameWindow(s[rk], cur.resetsAt)).map((s) => ({ t: s.t, u: s[uk] }));
    if (pts.length <= max) return pts;
    const step = pts.length / max;
    const out = [];
    for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
    out.push(pts[pts.length - 1]);
    return out;
  }

  snapshot() {
    return {
      ...this.state,
      forecast: this.forecast(),
      series: { five_hour: this.#series('u5', 'r5', 'five_hour', 240), seven_day: this.#series('u7', 'r7', 'seven_day', 240) },
      costTotal: this.costTotal,
      lastActivity: this.lastActivity,
    };
  }
}
