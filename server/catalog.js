import { query } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'node:events';
import { priceTable } from './session-stats.js';
import { withTimeout } from './util.js';

const USAGE_FN = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

/** Models (with list prices), slash commands and account info – from a session's init or a probe. */
export class Catalog extends EventEmitter {
  constructor({ store }) {
    super();
    this.store = store;
    this.file = store.p('catalog.json');
    this.models = [];
    this.prices = {};
    this.commands = [];
    this.account = null;
    this.version = null;
    this.at = 0;
  }

  async load() {
    const d = await this.store.readJson(this.file, null);
    if (d) Object.assign(this, { models: d.models ?? [], prices: d.prices ?? {}, commands: d.commands ?? [], account: d.account ?? null, version: d.version ?? null, at: d.at ?? 0 });
  }

  ingestInit(init) {
    if (!init) return;
    if (Array.isArray(init.models) && init.models.length) {
      this.models = init.models.map((m) => ({
        value: m.value,
        resolvedModel: m.resolvedModel ?? null,
        displayName: m.displayName,
        description: m.description,
        supportsEffort: !!m.supportsEffort,
        supportedEffortLevels: m.supportedEffortLevels ?? [],
        supportsAutoMode: !!m.supportsAutoMode,
      }));
      this.prices = priceTable(init.models);
    }
    if (Array.isArray(init.commands)) {
      this.commands = init.commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint ?? '', builtin: !!c.builtin }));
    }
    if (init.account) this.account = init.account;
    if (init.claude_code_version) this.version = init.claude_code_version;
    this.at = Date.now();
    this.store.writeJson(this.file, { models: this.models, prices: this.prices, commands: this.commands, account: this.account, version: this.version, at: this.at });
    this.emit('change');
  }

  snapshot() {
    return { models: this.models, prices: this.prices, commands: this.commands, account: this.account, version: this.version, at: this.at };
  }
}

/**
 * Short-lived Claude Code process without a prompt: answers init (models, account) and the
 * plan-usage call. Used when no session is running. No transcript is written.
 */
export class Probe {
  constructor(ctx) {
    this.ctx = ctx;
    this.running = null;
  }

  run({ usage = true } = {}) {
    if (this.running) return this.running;
    this.running = this.#run(usage).finally(() => { this.running = null; });
    return this.running;
  }

  async #run(wantUsage) {
    const { config, store } = this.ctx;
    let release;
    const hold = new Promise((r) => { release = r; });
    const prompt = (async function* idle() { await hold; })();
    const q = (this.ctx.query ?? query)({
      prompt,
      options: {
        cwd: store.p('probe'),
        persistSession: false,
        permissionMode: 'default',
        settingSources: ['user'],
        strictMcpConfig: true,
        mcpServers: {},
        pathToClaudeCodeExecutable: config.claudeBin || undefined,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'agent-cockpit/1.0' },
        stderr: () => {},
      },
    });
    const drain = (async () => { try { for await (const _ of q) { /* discard */ } } catch { /* closed */ } })();
    try {
      const init = await withTimeout(q.initializationResult(), 45_000, 'Claude-Code-Start');
      this.ctx.catalog.ingestInit(init);
      let usage = null;
      if (wantUsage && typeof q[USAGE_FN] === 'function') {
        usage = await withTimeout(q[USAGE_FN]({ skipBehaviors: true }), 25_000, 'Usage-Abfrage').catch(() => null);
      }
      return { init, usage };
    } finally {
      try { q.close(); } catch { /* ignore */ }
      release();
      await Promise.race([drain, new Promise((r) => setTimeout(r, 3000))]);
    }
  }
}

/** Refreshes plan limits: after turns (throttled) and periodically while a browser is connected. */
export class UsagePoller {
  constructor(ctx) {
    this.ctx = ctx;
    this.lastFetch = 0;
    this.inflight = null;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.#tick(), 30_000);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  #tick() {
    const { hub, config, limits, runners } = this.ctx;
    if (!hub.clientCount()) return;
    if (Date.now() - this.lastFetch < config.usagePollSec * 1000) return;
    const live = runners.anyLive();
    // Without a running session only poll while the 5-hour window is relevant
    if (live || Date.now() - limits.lastActivity < 5 * 3600_000 || !limits.state.at) this.fetch(live);
  }

  afterTurn(runner) {
    if (Date.now() - this.lastFetch > 60_000) this.fetch(runner);
  }

  fetch(runner = this.ctx.runners.anyLive()) {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        let resp = null;
        if (runner?.q && typeof runner.q[USAGE_FN] === 'function') {
          resp = await withTimeout(runner.q[USAGE_FN]({ skipBehaviors: true }), 25_000, 'Usage-Abfrage');
        } else {
          resp = (await this.ctx.probe.run({ usage: true })).usage;
        }
        if (resp) this.ctx.limits.ingestUsage(resp);
        return resp;
      } catch (e) {
        console.warn(`[usage] ${e.message}`);
        return null;
      } finally {
        this.lastFetch = Date.now();
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
