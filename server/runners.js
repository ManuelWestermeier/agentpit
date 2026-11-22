import { Runner } from './runner.js';

export class Runners {
  constructor(ctx) {
    this.ctx = ctx;
    this.map = new Map();
  }

  async get(projectId) {
    let r = this.map.get(projectId);
    if (!r) {
      const project = await this.ctx.projects.get(projectId);
      r = new Runner(this.ctx, project);
      this.map.set(projectId, r);
    }
    return r;
  }

  peek(projectId) { return this.map.get(projectId) ?? null; }

  liveCount() {
    let n = 0;
    for (const r of this.map.values()) if (r.live) n++;
    return n;
  }

  anyLive() {
    for (const r of this.map.values()) if (r.live) return r;
    return null;
  }

  snapshots() {
    const out = {};
    for (const [id, r] of this.map) out[id] = r.snapshot();
    return out;
  }

  async drop(projectId) {
    const r = this.map.get(projectId);
    if (!r) return;
    await r.stop('removed');
    if (r.relayToken) this.ctx.relay?.remove(r.relayToken);
    this.map.delete(projectId);
  }

  async shutdown() {
    await Promise.all([...this.map.values()].map((r) => r.stop('shutdown')));
  }
}
