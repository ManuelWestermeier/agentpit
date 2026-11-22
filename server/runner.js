import { query } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { playwrightMcpCli } from './environment.js';
import { addModelUsage, diffModelUsage, emptyStats } from './session-stats.js';
import { AsyncQueue, TailBuffer, UserError, debounce, isUuid, stripAnsi, throttle, uuid } from './util.js';

const SAFE_BROWSER_TOOLS = new Set([
  'navigate', 'navigate_back', 'snapshot', 'take_screenshot', 'click', 'hover', 'type', 'press_key', 'fill_form',
  'select_option', 'drag', 'wait_for', 'tabs', 'resize', 'close', 'console_messages', 'network_requests',
  'network_request', 'handle_dialog', 'emulate_media', 'find', 'evaluate', 'pdf_save', 'mouse_move_xy',
  'mouse_click_xy', 'mouse_drag_xy', 'mouse_down', 'mouse_up', 'mouse_wheel', 'start_video', 'stop_video',
  'video_chapter', 'video_show_actions', 'video_hide_actions', 'highlight', 'hide_highlight',
  'start_tracing', 'stop_tracing',
].map((n) => `mcp__playwright__browser_${n}`));
// Approved without asking (only reached when mode/rules would ask). Always asks:
// browser_run_code_unsafe (RCE-equivalent), browser_file_upload / browser_drop (can send local files to websites)

const COCKPIT_APPEND = `# Umgebung: Agent Cockpit
- Du läufst headless im "Agent Cockpit", einer lokalen Weboberfläche. Der Nutzer sieht Tool-Aufrufe, Befehle und Ausgaben live und erteilt Freigaben dort.
- Kein interaktives Terminal: Befehle dürfen nicht auf Eingaben warten (-y/--yes, kein Pager, kein Editor).
- Ergebnisse (Video, Bild, Audio, PDF, HTML) nach ./output/ schreiben – das Cockpit zeigt sie dort als Vorschau. Uploads des Nutzers liegen in ./input/.
- Lange Jobs (Renderings, Dev-Server) im Hintergrund starten, damit der Nutzer weiter steuern kann.`;

// Messages that are shown live but not written to the event log
const SYSTEM_SKIP_LOG = new Set([
  'session_state_changed', 'background_tasks_changed', 'commands_changed', 'thinking_tokens',
  'hook_started', 'hook_progress', 'hook_response', 'task_progress', 'files_persisted', 'task_updated',
]);

const STATE_FROM_CLI = { running: 'running', idle: 'ready', requires_action: 'waiting' };

/**
 * One Claude Code process (Agent SDK query in streaming-input mode) per project.
 * Started lazily on the first prompt, resumed by session id, closed after idle timeout.
 */
export class Runner extends EventEmitter {
  constructor(ctx, project) {
    super();
    this.ctx = ctx;
    this.projectId = project.id;
    this.project = project;
    this.sessionId = isUuid(project.lastSessionId) ? project.lastSessionId : null;
    this.q = null;
    this.queue = null;
    this.state = 'idle';            // idle | starting | ready | running | waiting | error
    this.error = null;
    this.pending = new Map();       // permission requests awaiting the user
    this.bgTasks = [];
    this.mcp = [];
    this.commands = [];
    this.model = null;
    this.mode = project.mode;
    this.effort = project.effort || '';
    this.version = null;
    this.compacting = false;
    this.suggestion = null;
    this.stats = null;
    this.proc = null;               // per-process cumulative counters
    this.turn = null;
    this.seen = new Map();          // assistant message.id → { out }
    this.stream = { text: '', thinking: '', out: 0 };
    this.lastActivityAt = 0;
    this.closing = null;            // reason when we close on purpose
    this.idleTimer = null;
    this.stderr = new TailBuffer(16_000);

    this.emitStatus = throttle(() => this.ctx.hub.toAll({ t: 'runner', projectId: this.projectId, status: this.snapshot() }), 120);
    this.saveStats = debounce(() => {
      if (this.stats && this.sessionId) this.ctx.store.writeStats(this.projectId, this.sessionId, this.stats);
    }, 800);
    this.flushStream = throttle(() => this.#flushStream(), 60);
  }

  get live() { return !!this.q; }

  snapshot() {
    return {
      projectId: this.projectId,
      state: this.state,
      live: this.live,
      sessionId: this.sessionId,
      model: this.model,
      mode: this.mode,
      effort: this.effort,
      version: this.version,
      compacting: this.compacting,
      error: this.error,
      pending: [...this.pending.values()].map((p) => p.req),
      bgTasks: this.bgTasks,
      mcp: this.mcp,
      commands: this.commands,
      suggestion: this.suggestion,
      lastActivityAt: this.lastActivityAt,
      turn: this.turn ? { startedAt: this.turn.startedAt, calls: this.turn.calls, out: this.stream.out } : null,
      stats: this.stats,
    };
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    if (s !== 'error') this.error = null;
    this.emitStatus();
    this.emit('state', s);
  }

  // ---------------------------------------------------------------- lifecycle

  async #loadStats(sessionId, forkedFrom = null) {
    const stored = await this.ctx.store.readStats(this.projectId, sessionId);
    this.stats = stored ?? { ...emptyStats(this.projectId, sessionId), forkedFrom };
  }

  async selectSession(sessionId) {
    if (sessionId != null && !isUuid(sessionId)) throw new UserError('Ungültige Session-ID');
    if (this.live && sessionId !== this.sessionId) await this.stop('switch');
    this.sessionId = sessionId;
    this.stats = null;
    if (sessionId) await this.#loadStats(sessionId);
    this.suggestion = null;
    await this.ctx.projects.touch(this.projectId, { lastSessionId: sessionId });
    this.emitStatus();
  }

  #buildOptions() {
    const { config, env, root } = this.ctx;
    const p = this.project;
    const mcpServers = {};
    const cli = playwrightMcpCli(root);
    if (config.browserMcp && p.browser?.enabled !== false && cli) {
      const args = [
        cli,
        '--caps', 'vision,pdf,devtools',
        '--output-dir', path.join(p.dir, 'output', 'browser'),
        '--user-data-dir', this.ctx.store.p('browser', this.projectId),
        '--viewport-size', '1280x720',
        '--image-responses', 'allow',
      ];
      if (env.browser.channel) args.push('--browser', env.browser.channel);
      if (p.browser?.headless) args.push('--headless');
      mcpServers.playwright = { type: 'stdio', command: process.execPath, args };
    }

    const mode = p.mode === 'bypassPermissions' && !config.allowBypass ? 'acceptEdits' : p.mode;
    return {
      cwd: p.dir,
      model: p.model || undefined,
      permissionMode: mode || 'default',
      allowDangerouslySkipPermissions: config.allowBypass || undefined,
      effort: p.effort || undefined,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: COCKPIT_APPEND },
      mcpServers,
      mcpServersDelivery: 'initialize',
      canUseTool: (toolName, input, opts) => this.#canUseTool(toolName, input, opts),
      enableFileCheckpointing: true,
      perTaskStopAffordance: true,
      promptSuggestions: config.promptSuggestions || undefined,
      pathToClaudeCodeExecutable: config.claudeBin || undefined,
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: 'agent-cockpit/1.0',
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      },
      stderr: (d) => this.stderr.push(stripAnsi(d)),
    };
  }

  async ensureStarted({ resume = this.sessionId, fork = false } = {}) {
    if (this.q) return;
    const { runners, config } = this.ctx;
    if (runners.liveCount() >= config.maxRunners) {
      throw new UserError(`Schon ${config.maxRunners} Sessions aktiv (MAX_RUNNERS). Beende zuerst eine.`);
    }
    this.project = await this.ctx.projects.get(this.projectId);
    const options = this.#buildOptions();
    let sessionId;
    if (resume && isUuid(resume)) {
      options.resume = resume;
      if (fork) {
        sessionId = uuid();
        options.forkSession = true;
        options.sessionId = sessionId;
      } else sessionId = resume;
    } else {
      sessionId = uuid();
      options.sessionId = sessionId;
    }
    this.sessionId = sessionId;
    await this.#loadStats(sessionId, fork ? resume : null);
    this.proc = { totalCost: 0, modelUsage: {}, initLogged: false, startedAt: Date.now() };
    this.seen.clear();
    this.stderr = new TailBuffer(16_000);
    this.error = null;
    this.mode = options.permissionMode;
    this.effort = this.project.effort || '';
    this.queue = new AsyncQueue();
    this.closing = null;
    this.setState('starting');

    const q = (this.ctx.query ?? query)({ prompt: this.queue, options });
    this.q = q;
    this.#log('cockpit', 'runner_started', { resumed: !!options.resume && !fork, forkedFrom: fork ? resume : null });
    this.pump = this.#pump(q);
    q.initializationResult()
      .then((init) => {
        if (this.q !== q) return;
        this.commands = (init.commands ?? []).map((c) => c.name);
        this.version = init.claude_code_version ?? this.version;
        this.ctx.catalog.ingestInit(init);
        if (this.state === 'starting') this.setState('ready');
        this.emitStatus();
      })
      .catch(() => {});
    await this.ctx.projects.touch(this.projectId, { lastSessionId: sessionId });
    this.ctx.sessions.invalidate(this.projectId);
  }

  async #pump(q) {
    let error = null;
    try {
      for await (const msg of q) await this.#onMessage(msg);
    } catch (e) {
      error = e;
    }
    if (this.q === q) this.#onExit(error);
  }

  #onExit(error) {
    this.q = null;
    this.queue?.close();
    this.queue = null;
    clearTimeout(this.idleTimer);
    for (const p of this.pending.values()) p.resolve({ behavior: 'deny', message: 'Session beendet.' });
    this.pending.clear();
    this.bgTasks = [];
    this.turn = null;
    this.compacting = false;
    this.stream = { text: '', thinking: '', out: 0 };
    this.ctx.hub.toProject(this.projectId, { t: 'live', projectId: this.projectId, k: 'stream_reset' });
    this.saveStats.flush();
    const reason = this.closing;
    this.closing = null;
    if (error && !reason) {
      const tail = this.stderr.toString().trim().split('\n').slice(-6).join('\n');
      this.error = `${error.message}${tail ? `\n${tail}` : ''}`;
      this.#log('cockpit', 'error', { text: this.error });
      this.state = 'error';
      this.emitStatus();
    } else {
      this.#log('cockpit', 'runner_stopped', { reason: reason ?? 'exit' });
      this.setState('idle');
    }
    this.ctx.sessions.invalidate(this.projectId);
    this.emit('exit');
  }

  async stop(reason = 'user') {
    if (!this.q) return;
    this.closing = reason;
    const done = new Promise((r) => this.once('exit', r));
    try { this.q.close(); } catch { /* already closing */ }
    await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
  }

  #scheduleIdle() {
    clearTimeout(this.idleTimer);
    const min = this.ctx.config.idleTimeoutMin;
    if (!min) return;
    this.idleTimer = setTimeout(() => {
      const quiet = Date.now() - this.lastActivityAt >= min * 60_000 - 1000;
      if (this.q && this.state === 'ready' && !this.pending.size && !this.bgTasks.length && quiet) this.stop('idle');
      else if (this.q) this.#scheduleIdle();
    }, min * 60_000);
    this.idleTimer.unref?.();
  }

  // ---------------------------------------------------------------- input

  async send(text) {
    const prompt = String(text ?? '').trim();
    if (!prompt) return;
    if (prompt.length > 400_000) throw new UserError('Prompt zu lang (max. 400 000 Zeichen)');
    await this.ensureStarted();
    const id = uuid();
    const busy = this.state === 'running' || this.state === 'waiting' || this.compacting;
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
      uuid: id,
    });
    this.suggestion = null;
    this.lastActivityAt = Date.now();
    if (!busy) this.#beginTurn();
    if (!this.stats.firstPrompt && !prompt.startsWith('/')) this.stats.firstPrompt = prompt.slice(0, 200);
    this.#log('cockpit', 'user_prompt', { text: prompt, uuid: id, queued: busy });
    this.saveStats();
    this.emitStatus();
  }

  #beginTurn() {
    this.turn = { startedAt: Date.now(), calls: 0, ctxStart: this.stats?.context?.tokens ?? 0, costStart: this.proc?.totalCost ?? 0 };
    this.stream.out = 0;
    this.setState('running');
  }

  async interrupt() {
    if (!this.q) return;
    await this.q.interrupt().catch((e) => { throw new UserError(`Unterbrechen fehlgeschlagen: ${e.message}`); });
    for (const p of this.pending.values()) p.resolve({ behavior: 'deny', message: 'Vom Nutzer unterbrochen.', interrupt: true });
    this.pending.clear();
    this.emitStatus();
  }

  async setModel(model) {
    const m = String(model ?? '').trim();
    this.project = await this.ctx.projects.update(this.projectId, { model: m });
    if (this.q) await this.q.setModel(m || undefined);
    this.#log('cockpit', 'setting', { key: 'model', value: m || 'Standard' });
    this.emitStatus();
  }

  async setMode(mode) {
    this.project = await this.ctx.projects.update(this.projectId, { mode });
    if (this.q) await this.q.setPermissionMode(mode);
    this.mode = mode;
    this.#log('cockpit', 'setting', { key: 'mode', value: mode });
    this.emitStatus();
  }

  async setEffort(effort) {
    this.project = await this.ctx.projects.update(this.projectId, { effort: effort ?? '' });
    if (this.q) await this.q.applyFlagSettings({ effortLevel: effort || null });
    this.effort = effort || '';
    this.#log('cockpit', 'setting', { key: 'effort', value: effort || 'Standard' });
    this.emitStatus();
  }

  async stopTask(taskId) {
    if (!this.q) return;
    await this.q.stopTask(String(taskId));
  }

  async rewind(userMessageId, dryRun) {
    if (!this.q) throw new UserError('Session läuft nicht – erst einen Prompt senden oder fortsetzen.');
    if (!isUuid(userMessageId)) throw new UserError('Ungültige Nachricht');
    const r = await this.q.rewindFiles(userMessageId, { dryRun: !!dryRun });
    if (!dryRun && r.canRewind) this.#log('cockpit', 'rewind', { userMessageId, files: r.filesChanged ?? [] });
    return r;
  }

  async contextDetail() {
    if (!this.q) throw new UserError('Session läuft nicht');
    return this.q.getContextUsage({ detail: 'full' });
  }

  // ---------------------------------------------------------------- permissions

  #canUseTool(toolName, input, opts) {
    if (SAFE_BROWSER_TOOLS.has(toolName)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    return new Promise((resolve) => {
      const id = opts.requestId || uuid();
      const suggestions = Array.isArray(opts.suggestions) ? opts.suggestions : [];
      const req = {
        id,
        toolName,
        input,
        title: opts.title ?? null,
        displayName: opts.displayName ?? null,
        description: opts.description ?? null,
        decisionReason: opts.decisionReason ?? null,
        blockedPath: opts.blockedPath ?? null,
        toolUseId: opts.toolUseID ?? null,
        agentId: opts.agentID ?? null,
        mcpServer: opts.mcpServer ?? null,
        canAlways: suggestions.length > 0 && !opts.suppressAlwaysAllowRule,
        defaultToNo: !!opts.defaultToNo,
        ts: Date.now(),
      };
      const entry = { req, input, suggestions, resolve: (r) => { resolve(r); } };
      this.pending.set(id, entry);
      opts.signal?.addEventListener('abort', () => {
        if (this.pending.delete(id)) {
          resolve({ behavior: 'deny', message: 'Abgebrochen.' });
          this.ctx.hub.toProject(this.projectId, { t: 'live', projectId: this.projectId, k: 'perm_done', id });
          this.emitStatus();
        }
      }, { once: true });
      this.#log('cockpit', 'permission_request', { req: { ...req, input: undefined }, toolName });
      this.setState('waiting');
      this.emitStatus();
      this.ctx.hub.toAll({ t: 'attention', projectId: this.projectId, toolName, title: req.title });
    });
  }

  respond(id, decision = {}) {
    const entry = this.pending.get(id);
    if (!entry) throw new UserError('Diese Anfrage ist nicht mehr offen');
    const { req, input, suggestions } = entry;
    let result;
    const updatedInput = decision.updatedInput && typeof decision.updatedInput === 'object' && !Array.isArray(decision.updatedInput)
      ? decision.updatedInput
      : input;
    if (JSON.stringify(updatedInput).length > 1_000_000) throw new UserError('Eingabe zu groß');

    switch (decision.decision) {
      case 'allow':
        result = { behavior: 'allow', updatedInput };
        if (req.toolName === 'ExitPlanMode' && this.ctx.config.permissionModes.includes(decision.mode) && decision.mode !== 'plan') {
          if (decision.mode === 'bypassPermissions' && !this.ctx.config.allowBypass) throw new UserError('bypassPermissions ist gesperrt');
          result.updatedPermissions = [{ type: 'setMode', mode: decision.mode, destination: 'session' }];
        }
        break;
      case 'always': {
        if (!req.canAlways) throw new UserError('Für diese Aktion gibt es keine Dauerfreigabe');
        const local = suggestions.filter((s) => s.destination === 'localSettings');
        result = { behavior: 'allow', updatedInput, updatedPermissions: local.length ? local : suggestions };
        break;
      }
      case 'deny':
        result = { behavior: 'deny', message: String(decision.message || 'Vom Nutzer abgelehnt.').slice(0, 4000) };
        break;
      default:
        throw new UserError('Unbekannte Entscheidung');
    }
    this.pending.delete(id);
    entry.resolve(result);
    this.#log('cockpit', 'permission_decision', {
      id, toolName: req.toolName, decision: decision.decision, message: result.message ?? null,
      answers: req.toolName === 'AskUserQuestion' ? updatedInput.answers ?? null : undefined,
    });
    if (!this.pending.size && this.state === 'waiting') this.setState('running');
    this.emitStatus();
  }

  // ---------------------------------------------------------------- stream handling

  async #onMessage(msg) {
    this.lastActivityAt = Date.now();
    const { type: t, subtype: st } = msg;

    if (msg.session_id && isUuid(msg.session_id) && msg.session_id !== this.sessionId && t !== 'conversation_reset' && t === 'system' && st === 'init') {
      // The CLI decided on a different id (e.g. resume of a session that moved) – follow it.
      this.sessionId = msg.session_id;
      await this.#loadStats(msg.session_id);
      this.ctx.projects.touch(this.projectId, { lastSessionId: msg.session_id });
    }

    switch (t) {
      case 'stream_event': return this.#onStreamEvent(msg);
      case 'keep_alive':
      case 'active_goal':
        return;
      case 'autocompact_state':
        if (this.stats && msg.value?.threshold) {
          this.stats.context.threshold = msg.value.threshold;
          if (msg.value.effective_window) this.stats.context.window = msg.value.effective_window;
          this.emitStatus();
        }
        return;
      case 'tool_progress':
        this.ctx.hub.toProject(this.projectId, {
          t: 'live', projectId: this.projectId, k: 'tool_progress',
          toolUseId: msg.tool_use_id, elapsed: msg.elapsed_time_seconds, parent: msg.parent_tool_use_id,
        });
        return;
      case 'prompt_suggestion':
        this.suggestion = msg.suggestion;
        this.emitStatus();
        return;
      case 'command_lifecycle':
        this.ctx.hub.toProject(this.projectId, { t: 'live', projectId: this.projectId, k: 'cmd', uuid: msg.command_uuid, state: msg.state });
        return;
      case 'rate_limit_event':
        this.ctx.limits.ingestEvent(msg.rate_limit_info);
        if (msg.rate_limit_info?.status === 'allowed') return;
        break;
      case 'conversation_reset':
        await this.#log(null, null, msg);
        this.sessionId = isUuid(msg.new_conversation_id) ? msg.new_conversation_id : uuid();
        this.stats = emptyStats(this.projectId, this.sessionId);
        this.proc.totalCost = 0;
        this.proc.modelUsage = {};
        this.#log('cockpit', 'session_reset', { from: msg.session_id });
        this.ctx.projects.touch(this.projectId, { lastSessionId: this.sessionId });
        this.ctx.sessions.invalidate(this.projectId);
        this.emitStatus();
        return;
      case 'system':
        if (this.#onSystem(msg) === false) return;
        break;
      case 'assistant':
        this.#onAssistant(msg);
        break;
      case 'result':
        this.#onResult(msg);
        break;
      default:
        break;
    }
    await this.#log(null, null, msg);
  }

  /** Returns false when the message should not be logged. */
  #onSystem(msg) {
    switch (msg.subtype) {
      case 'init':
        this.model = msg.model ?? this.model;
        this.mode = msg.permissionMode ?? this.mode;
        this.mcp = (msg.mcp_servers ?? []).map((s) => ({ name: s.name, status: s.status }));
        this.commands = msg.slash_commands ?? this.commands;
        this.version = msg.claude_code_version ?? this.version;
        if (this.stats) this.stats.model = this.model;
        if (this.state === 'starting') this.setState('ready');
        if (!this.turn && this.state !== 'starting') this.#beginTurn();
        this.emitStatus();
        if (this.proc.initLogged) return false;
        this.proc.initLogged = true;
        return true;
      case 'session_state_changed': {
        const s = STATE_FROM_CLI[msg.state];
        if (s === 'running' && !this.turn) this.#beginTurn();
        else if (s && !(s === 'ready' && this.turn)) this.setState(this.pending.size ? 'waiting' : s);
        return false;
      }
      case 'status':
        this.compacting = msg.status === 'compacting';
        if (msg.permissionMode) this.mode = msg.permissionMode;
        this.emitStatus();
        return !!msg.compact_result;
      case 'background_tasks_changed':
        this.bgTasks = (msg.tasks ?? []).filter((x) => !x.ambient);
        this.emitStatus();
        return false;
      case 'commands_changed':
        this.commands = (msg.commands ?? []).map((c) => c.name);
        this.emitStatus();
        return false;
      case 'task_progress':
        this.ctx.hub.toProject(this.projectId, {
          t: 'live', projectId: this.projectId, k: 'task_progress',
          toolUseId: msg.tool_use_id, taskId: msg.task_id, usage: msg.usage, last: msg.last_tool_name, summary: msg.summary,
        });
        return false;
      default:
        return !SYSTEM_SKIP_LOG.has(msg.subtype);
    }
  }

  #onStreamEvent(msg) {
    if (msg.parent_tool_use_id) return;
    const ev = msg.event;
    if (!ev) return;
    if (ev.type === 'message_start') {
      this.stream.text = '';
      this.stream.thinking = '';
      this.ctx.hub.toProject(this.projectId, { t: 'live', projectId: this.projectId, k: 'stream_reset' });
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta;
      if (d?.type === 'text_delta') this.stream.text += d.text;
      else if (d?.type === 'thinking_delta') this.stream.thinking += d.thinking;
      else return;
      this.flushStream();
    } else if (ev.type === 'message_delta' && ev.usage?.output_tokens) {
      this.stream.out = ev.usage.output_tokens;
    }
  }

  #flushStream() {
    const { text, thinking } = this.stream;
    if (!text && !thinking) return;
    this.stream.text = '';
    this.stream.thinking = '';
    this.ctx.hub.toProject(this.projectId, { t: 'live', projectId: this.projectId, k: 'stream', text, thinking });
  }

  #onAssistant(msg) {
    const m = msg.message;
    if (!m || m.model === '<synthetic>') {
      if (msg.error === 'authentication_failed' || msg.error === 'oauth_org_not_allowed') this.ctx.auth.refresh();
      return;
    }
    this.flushStream();
    const now = Date.now();
    this.stats.lastApiAt = now;
    const u = m.usage ?? {};
    let rec = this.seen.get(m.id);
    if (!rec) {
      rec = { out: 0 };
      this.seen.set(m.id, rec);
      if (this.seen.size > 4000) this.seen.delete(this.seen.keys().next().value);
      if (!this.turn) this.#beginTurn();
      this.turn.calls++;
      this.stats.apiCalls++;
    }
    const out = u.output_tokens ?? 0;
    if (out > rec.out) {
      this.stats.outTokens += out - rec.out;
      rec.out = out;
    }
    const topLevel = !msg.parent_tool_use_id && !msg.agent_id;
    if (topLevel) {
      const ctxTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + out;
      if (ctxTokens > 0) this.stats.context.tokens = ctxTokens;
      const cc = u.cache_creation;
      if (cc?.ephemeral_1h_input_tokens > 0) this.stats.cacheTtl = '1h';
      else if (cc?.ephemeral_5m_input_tokens > 0 && !this.stats.cacheTtl) this.stats.cacheTtl = '5m';
      if (m.model) this.stats.model = m.model;
    }
    this.ctx.limits.lastActivity = now;
    this.emitStatus();
  }

  #onResult(msg) {
    const total = Number(msg.total_cost_usd) || 0;
    const delta = Math.max(0, total - this.proc.totalCost);
    this.proc.totalCost = total;
    const deltas = diffModelUsage(this.proc.modelUsage, msg.modelUsage);
    this.proc.modelUsage = msg.modelUsage ?? this.proc.modelUsage;
    const s = this.stats;
    addModelUsage(s, deltas);
    for (const d of Object.values(msg.modelUsage ?? {})) {
      if (d.contextWindow && !s.context.max) s.context.max = d.contextWindow;
    }
    s.costUsd += delta;
    s.turns += 1;
    s.updatedAt = Date.now();
    const turn = this.turn ?? { startedAt: Date.now() - (msg.duration_ms ?? 0), calls: 0, ctxStart: s.context.tokens };
    s.turnLog.push({
      ts: Date.now(),
      cost: delta,
      ms: msg.duration_ms ?? Date.now() - turn.startedAt,
      calls: turn.calls,
      ctxStart: turn.ctxStart,
      ctxEnd: s.context.tokens,
      err: !!msg.is_error,
      cmd: msg.local_command ?? null,
    });
    if (s.turnLog.length > 200) s.turnLog.splice(0, s.turnLog.length - 200);
    msg._cockpit = { costDelta: delta, calls: turn.calls };
    this.ctx.limits.addCost(delta);
    this.turn = null;
    this.stream.out = 0;
    this.saveStats();
    this.setState(this.pending.size ? 'waiting' : 'ready');
    if ((msg.queued_turn_count ?? 0) > 0) this.#beginTurn();
    this.#scheduleIdle();
    this.#afterTurn();
  }

  async #afterTurn() {
    const q = this.q;
    if (!q) return;
    try {
      const r = await q.getContextUsage({ detail: 'summary' });
      if (this.q !== q || !this.stats) return;
      const buffer = (r.categories ?? []).filter((c) => c.kind === 'buffer').reduce((a, c) => a + c.tokens, 0);
      const c = this.stats.context;
      c.tokens = r.totalTokens ?? c.tokens;
      c.max = r.rawMaxTokens ?? r.maxTokens ?? c.max;
      c.pct = r.percentage ?? c.pct;
      if (!c.threshold && r.maxTokens) c.threshold = r.maxTokens - buffer;
      c.categories = (r.categories ?? []).filter((x) => x.kind === 'used' && x.tokens > 0).map((x) => ({ id: x.id ?? x.name, name: x.name, tokens: x.tokens }));
      this.saveStats();
      this.emitStatus();
    } catch { /* older CLI or process closing */ }
    this.ctx.usagePoller.afterTurn(this);
    this.ctx.sessions.invalidate(this.projectId);
    this.ctx.files.touched(this.projectId);
  }

  // ---------------------------------------------------------------- persistence

  /** Writes to the session log and pushes to subscribed clients. */
  async #log(type, subtype, payload) {
    if (!this.sessionId) return;
    let ev;
    if (type === 'cockpit') ev = { type: 'cockpit', subtype, uuid: uuid(), ...payload };
    else ev = await this.ctx.media.sanitize(payload);
    ev._ts = Date.now();
    const sessionId = this.sessionId;
    this.ctx.store.appendEvent(this.projectId, sessionId, ev);
    this.ctx.hub.toProject(this.projectId, { t: 'ev', projectId: this.projectId, sessionId, ev });
  }
}
