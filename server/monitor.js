import fs from 'node:fs';
import os from 'node:os';

const cpuTimes = () => os.cpus().reduce((a, c) => {
  const t = c.times;
  a.idle += t.idle;
  a.total += t.user + t.nice + t.sys + t.idle + t.irq;
  return a;
}, { idle: 0, total: 0 });

/** Available memory: Linux counts reclaimable cache as available (MemAvailable), os.freemem() does not. */
function memory() {
  const total = os.totalmem();
  if (process.platform === 'linux') {
    try {
      const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
      if (m) return { total, used: total - Number(m[1]) * 1024 };
    } catch { /* fall back */ }
  }
  return { total, used: total - os.freemem() };
}

/** Hottest thermal zone in °C (Linux, e.g. Jetson, Raspberry Pi) – null elsewhere. */
function temperature() {
  if (process.platform !== 'linux') return null;
  let max = null;
  try {
    for (const z of fs.readdirSync('/sys/class/thermal').filter((d) => d.startsWith('thermal_zone'))) {
      const v = Number(fs.readFileSync(`/sys/class/thermal/${z}/temp`, 'utf8')) / 1000;
      if (Number.isFinite(v) && v > 0 && v < 150) max = Math.max(max ?? 0, v);
    }
  } catch { /* none */ }
  return max == null ? null : Math.round(max);
}

function disk(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { return null; }
}

/**
 * Server health every few seconds while an admin is connected: CPU, RAM, disk, temperature, load,
 * plus the CPU of each running browser identity (CDP SystemInfo, summed over its processes).
 * Sustained overload raises a warning in the UI – a remote server should never silently crawl.
 */
export class Monitor {
  constructor(ctx, intervalMs = 3000) {
    this.ctx = ctx;
    this.intervalMs = intervalMs;
    this.prev = cpuTimes();
    this.browserCpu = new Map(); // id → { t, cpu }
    this.hot = 0;
    this.last = null;
    this.history = []; // last ~10 min of { t, cpu, mem }
  }

  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  async #browserLoad() {
    const out = [];
    for (const [id, e] of this.ctx.browsers?.running ?? []) {
      if (!e.ready || !e.cdp) continue;
      try {
        const { processInfo } = await e.cdp.send('SystemInfo.getProcessInfo', {}, null, 2000);
        const cpu = processInfo.reduce((s, p) => s + (p.cpuTime ?? 0), 0);
        const prev = this.browserCpu.get(id);
        const now = Date.now();
        this.browserCpu.set(id, { t: now, cpu });
        const pct = prev ? ((cpu - prev.cpu) / ((now - prev.t) / 1000) / os.cpus().length) * 100 : null;
        out.push({ id, name: e.profile?.name ?? id, cpu: pct == null ? null : Math.max(0, Math.round(pct)), processes: processInfo.length, viewers: e.viewers.size });
      } catch { /* browser busy or closing */ }
    }
    for (const id of this.browserCpu.keys()) if (!this.ctx.browsers?.running.has(id)) this.browserCpu.delete(id);
    return out;
  }

  async tick() {
    const admins = [...(this.ctx.hub?.clients ?? [])].filter((c) => !c.user);
    const cur = cpuTimes();
    const dTotal = cur.total - this.prev.total;
    const cpu = dTotal > 0 ? Math.round((1 - (cur.idle - this.prev.idle) / dTotal) * 100) : 0;
    this.prev = cur;
    if (!admins.length) return;
    const mem = memory();
    const memPct = Math.round((mem.used / mem.total) * 100);
    const d = disk(this.ctx.config.home);
    this.hot = cpu >= 90 || memPct >= 92 ? this.hot + 1 : 0;
    const level = this.hot >= 5 ? 'critical' : (cpu >= 90 || memPct >= 92 || (d && d.free / d.total < 0.05)) ? 'warning' : 'ok';
    this.history.push({ t: Date.now(), cpu, mem: memPct });
    if (this.history.length > 200) this.history.shift();
    this.last = {
      t: 'monitor', at: Date.now(), level,
      cpu, cores: os.cpus().length, load: os.loadavg().map((x) => Math.round(x * 100) / 100),
      mem: { used: mem.used, total: mem.total, pct: memPct },
      disk: d && { free: d.free, total: d.total, pct: Math.round((1 - d.free / d.total) * 100) },
      temp: temperature(), uptime: Math.round(os.uptime()), host: os.hostname(), platform: `${process.platform}-${process.arch}`,
      cockpitMb: Math.round(process.memoryUsage().rss / 1024 ** 2),
      sessions: this.ctx.runners?.liveCount?.() ?? 0,
      browsers: await this.#browserLoad(),
      history: this.history.slice(-60).map((h) => [h.cpu, h.mem]),
    };
    for (const c of admins) this.ctx.hub.send(c, this.last);
  }
}
