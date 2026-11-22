import { query } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { COCKPIT_SAFE_TOOLS, cockpitMcp } from './cockpit-mcp.js';
import { playwrightMcpCli } from './environment.js';
import { SHARED_DIR_NAME } from './projects.js';
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

const cockpitAppend = ({ projectId, sharedDir, parentId }) => `# Umgebung: Agent Cockpit
- Du läufst headless im "Agent Cockpit", einer lokalen Weboberfläche. Der Nutzer sieht Tool-Aufrufe, Befehle und Ausgaben live und erteilt Freigaben dort.
- Kein interaktives Terminal: Befehle dürfen nicht auf Eingaben warten (-y/--yes, kein Pager, kein Editor).
- Ergebnisse (Video, Bild, Audio, PDF, HTML) nach ./output/ schreiben – das Cockpit zeigt sie dort als Vorschau. Uploads des Nutzers liegen in ./input/.
- Lange Jobs (Renderings, Dev-Server) im Hintergrund starten, damit der Nutzer weiter steuern kann.
- Alles, was sich im Cockpit einrichten lässt – Datenbankverbindungen (db_connect), Dienste (service_define), Zeitpläne, Browser-Identitäten, Sub-Sessions –, richtest du selbst über die mcp__cockpit__-Tools ein; der Nutzer bestätigt per Freigabe. Bitte ihn nicht, das selbst in der Oberfläche zu tun. Nur Logins/Passwörter/2FA erledigt immer der Nutzer.
- Dieses Projekt/diese Session: "${projectId}"${parentId ? ` – gestartet von der Session "${parentId}" (Ergebnis dort per session_send melden, wenn die Aufgabe es verlangt)` : ''}.

## Verlauf in context/
Jede Session schreibt ihren vollständigen Verlauf (Prompts, deine Antworten, Zusammenfassungen) nach ./context/<datum>-<session>.md. Wird dein Kontext zusammengefasst, fehlen dir Details – dann dort nachlesen (grep), statt zu raten. Auch frühere Sessions dieses Projekts liegen dort.

## Gemeinsamer Ordner ../${SHARED_DIR_NAME}/
Absolut: ${sharedDir}
Alle Claude-Sessions im Cockpit lesen und schreiben dort – für Wissen, Daten und Übergaben zwischen Sessions (z. B. Recherche-Ergebnisse, Listen, Status einer Pipeline, globale Notizen über den Nutzer).
- Vor einer Aufgabe kurz ${SHARED_DIR_NAME}/README.md und passende Unterordner ansehen, ob es schon etwas gibt.
- Eigene Dateien sprechend benennen, Übergaben mit Projektname, z. B. ${SHARED_DIR_NAME}/pipelines/<name>/status.json.
- Andere Sessions können gleichzeitig schreiben: lieber neue Dateien anlegen oder anhängen als fremde überschreiben.
- Keine Passwörter, Tokens oder Zugangsdaten dort ablegen.

## Browser-Identitäten
Playwright (mcp__playwright__*) steuert eine Browser-Identität des Cockpits: ein eigenes Profil mit eigenen Logins, das der Nutzer live sieht.
- browser_info zeigt die aktive und alle verfügbaren Identitäten (mit Login-Hinweisen), browser_use wechselt sofort – auch mitten in der Aufgabe; der nächste Playwright-Aufruf läuft dann in der anderen Identität.
- Logins (Passwörter, 2FA) erledigt der Nutzer selbst im Cockpit; niemals Passwörter eintippen. Ist eine Seite nicht eingeloggt, sag dem Nutzer, in welcher Identität er sich anmelden soll.

## Datenbanken und Diagramme (mcp__cockpit__*)
- db_create legt eine SQLite-Datenbank im Projekt an; db_connect richtet bestehende ein (SQLite, PostgreSQL, MySQL – Zugangsdaten nur vom Nutzer).
- db_connections(all: true) zeigt die Datenbanken aller Projekte; mit project-Parameter nutzt du sie (der Nutzer gibt den Zugriff frei).
- db_chart / chart_create zeichnen Diagramme (bar, line, area, scatter) nach output/charts/ – zum Visualisieren immer diese nehmen.

## Freigaben
Ressourcen außerhalb dieses Projekts (Datenbanken und Sessions anderer Projekte, nicht verknüpfte Browser-Identitäten) gibt der Nutzer frei – das Werkzeug fragt ihn selbst und wartet. Einfach aufrufen; bei Ablehnung nicht erneut versuchen, sondern Alternative nennen.

## Sub-Sessions und Zeitpläne (mcp__cockpit__*)
- session_create startet eine weitere Claude-Session (eigenes Projekt, optional eigene Browser-Identität) mit einer Aufgabe; session_send, session_status, session_wait, session_list, session_stop steuern sie. So lassen sich Arbeiten parallelisieren, z. B. eine Session pro Account/Identität.
- schedule_create sendet Prompts zeitgesteuert (einmalig, alle n Minuten oder Cron) an eine Session; schedule_list / schedule_delete verwalten sie.
- Übergaben zwischen Sessions über ${SHARED_DIR_NAME}/ (Dateien) statt langer Prompts.`;

const SHARED_README = `# Gemeinsamer Ordner aller Claude-Sessions

Jede Session im Agent Cockpit kann hier lesen und schreiben (aus einem Projekt: \`../${SHARED_DIR_NAME}/\`).
Gedacht für Wissen, Daten und Übergaben zwischen Sessions und Projekten.

Vorschlag für die Ordnung:
- \`notes/\` – dauerhafte Notizen (über den Nutzer, Vorlieben, Konventionen)
- \`data/\` – gemeinsame Datensätze, Listen
- \`pipelines/<name>/\` – Status und Zwischenergebnisse mehrstufiger Abläufe (Recherche → Schnitt → Veröffentlichung)

Keine Passwörter, Tokens oder Zugangsdaten hier ablegen.
`;

/** ../shared-claude/ next to the projects, with a README on first use. */
async function ensureSharedDir(projectsDir) {
  const dir = path.join(projectsDir, SHARED_DIR_NAME);
  await fsp.mkdir(dir, { recursive: true });
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) await fsp.writeFile(readme, SHARED_README).catch(() => {});
  return dir;
}

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
      turn: this.turn ? { startedAt: this.turn.startedAt, calls: this.turn.calls, out: this.stream.out, estCost: this.turn.estCost } : null,
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

  async #buildOptions() {
    const { config, root } = this.ctx;
    const p = this.project;
    const mcpServers = { cockpit: cockpitMcp(this.ctx, this.projectId) };
    const cli = playwrightMcpCli(root);
    if (config.browserMcp && p.browser?.enabled !== false && cli) {
      // Playwright always talks to the cockpit's CDP relay: it routes to the identity that is active
      // right now (linked one, else this project's isolated browser), starts it on demand and lets
      // the session switch identities mid-turn without restarting the MCP server.
      this.relayToken ??= this.ctx.relay.add(() => this.#resolveBrowser());
      const args = [cli, '--caps', 'vision,pdf,devtools', '--output-dir', path.join(p.dir, 'output', 'browser'), '--image-responses', 'allow',
        '--cdp-endpoint', this.ctx.relay.endpoint(this.relayToken)];
      mcpServers.playwright = { type: 'stdio', command: process.execPath, args, env: { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } };
    }
    const sharedDir = await ensureSharedDir(config.projectsDir);

    const mode = p.mode === 'bypassPermissions' && !config.allowBypass ? 'acceptEdits' : p.mode;
    return {
      cwd: p.dir,
      additionalDirectories: [sharedDir],
      model: p.model || undefined,
      permissionMode: mode || 'default',
      allowDangerouslySkipPermissions: config.allowBypass || undefined,
      effort: p.effort || undefined,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: cockpitAppend({ projectId: this.projectId, sharedDir, parentId: p.parentId }) },
      mcpServers,
      mcpServersDelivery: 'initialize',
      canUseTool: (toolName, input, opts) => this.#canUseTool(toolName, input, opts),
      hooks: {
        // compaction summary → context file (the full history stays readable)
        PostCompact: [{ hooks: [async (input) => { await this.appendContext('summary', `${input.trigger === 'auto' ? 'automatisch' : 'manuell'}:\n\n${input.compact_summary ?? ''}`); return {}; }] }],
      },
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

  // ---------------------------------------------------------------- browser identity

  /** Identity Claude's Playwright uses now: the linked one, else the project's isolated browser. */
  async activeBrowserId() {
    const p = await this.ctx.projects.get(this.projectId);
    if (p.browserProfile && this.ctx.browsers.profiles.has(p.browserProfile)) return p.browserProfile;
    return this.ctx.browsers.ensureIsolated(this.projectId, { headless: p.browser?.headless !== false });
  }

  /** Called by the CDP relay on every (re)connect of Playwright: start that browser if needed. */
  async #resolveBrowser() {
    const id = await this.activeBrowserId();
    this.browserInUse = id;
    return this.ctx.browsers.ensureRunning(id);
  }

  /** The project's identity changed: the next Playwright call reconnects to the new browser. */
  async browserChanged() {
    this.emitStatus();
    if (this.relayToken) await this.ctx.relay.retarget(this.relayToken);
  }

  // ---------------------------------------------------------------- context files

  /**
   * Full conversation as Markdown in <project>/context/<date>-<session>.md: every prompt, every
   * final answer and every compaction summary. Compaction shortens what Claude holds in its context –
   * nothing is lost, Claude (and the user) can look it up there.
   */
  async appendContext(kind, text) {
    if (!this.sessionId || !text) return;
    try {
      if (!this.stats.contextFile) {
        this.stats.contextFile = `context/${new Date().toISOString().slice(0, 10)}-${this.sessionId.slice(0, 8)}.md`;
        this.saveStats();
      }
      const file = path.join(this.project.dir, this.stats.contextFile);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const head = fs.existsSync(file) ? '' : `# Session ${this.sessionId}\n\nProjekt: ${this.project.name}\n\n`;
      const time = new Date().toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
      const title = { user: 'Nutzer', claude: 'Claude', summary: 'Kontext zusammengefasst', limit: 'Cockpit' }[kind] ?? kind;
      await fsp.appendFile(file, `${head}## ${time} · ${title}\n\n${String(text).trim()}\n\n`);
    } catch (e) {
      console.warn(`[context] ${this.projectId}: ${e.message}`);
    }
  }

  /** After an answer: summarise early when the context is ≥ AUTO_COMPACT_PCT full (0 = only Claude Code's own). */
  #maybeCompact(msg) {
    const pct = this.project?.autoCompactPct ?? this.ctx.config.autoCompactPct;
    const c = this.stats?.context;
    const max = c?.window || c?.max;
    if (!pct || !max || !c.tokens || msg.local_command || this.compacting || this.queue == null) return;
    if (c.tokens / max * 100 < pct) return;
    this.#log('cockpit', 'context_saved', { text: `Kontext zu ${Math.round(c.tokens / max * 100)} % voll – wird zusammengefasst; der vollständige Verlauf steht in ${this.stats.contextFile ?? 'context/'}` });
    this.send(`/compact Behalte Ziel, offene Aufgaben, getroffene Entscheidungen, wichtige Dateipfade und Zugangswege. Der vollständige Verlauf steht in ${this.stats.contextFile ?? 'context/'}.`, { source: 'auto-compact' }).catch(() => {});
  }

  /** Resolves when the current turn is over (or right away when idle); returns the last result. */
  waitIdle(timeoutMs) {
    const busy = () => this.state === 'running' || this.state === 'starting' || this.compacting;
    if (this.state === 'waiting') return Promise.resolve({ done: false, waitingForApproval: true, result: this.lastResult });
    if (!busy()) return Promise.resolve({ done: true, result: this.lastResult });
    return new Promise((resolve) => {
      const finish = (done, extra = {}) => { clearTimeout(timer); this.off('state', onState); resolve({ done, ...extra, result: this.lastResult }); };
      // a pending approval needs the user – report it instead of blocking the caller for the whole timeout
      const onState = () => { if (this.state === 'waiting') finish(false, { waitingForApproval: true }); else if (!busy()) finish(true); };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.on('state', onState);
    });
  }

  async ensureStarted({ resume = this.sessionId, fork = false } = {}) {
    if (this.q) return;
    const { runners, config } = this.ctx;
    if (runners.liveCount() >= config.maxRunners) {
      throw new UserError(`Schon ${config.maxRunners} Sessions aktiv (MAX_RUNNERS). Beende zuerst eine.`);
    }
    this.project = await this.ctx.projects.get(this.projectId);
    const options = await this.#buildOptions();
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
    clearInterval(this.limitTimer);
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
    // the isolated browser only serves this session – close it when nobody watches it
    const iso = this.browserInUse;
    if (iso && this.ctx.browsers.profiles.get(iso)?.isolatedFor === this.projectId && !this.ctx.browsers.running.get(iso)?.viewers.size) {
      this.ctx.browsers.stop(iso).catch(() => {});
    }
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

  async send(text, opts = {}) {
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
    if (!prompt.startsWith('/')) {
      this.lastPrompt = prompt;
      this.ctx.meta?.onPrompt(this.projectId, this.sessionId, prompt); // titles via Haiku, in the background
      this.appendContext('user', prompt);
    }
    this.#log('cockpit', 'user_prompt', { text: prompt, uuid: id, queued: busy, source: opts.source ?? null });
    this.saveStats();
    this.emitStatus();
  }

  #beginTurn() {
    this.turn = { startedAt: Date.now(), calls: 0, ctxStart: this.stats?.context?.tokens ?? 0, costStart: this.proc?.totalCost ?? 0, estCost: 0 };
    this.stream.out = 0;
    this.setState('running');
    clearInterval(this.limitTimer);
    this.limitTimer = setInterval(() => this.#checkLimits(), 2000);
    this.limitTimer.unref?.();
  }

  /**
   * Per-answer limits of the project (cost, share of the 5-h limit, time, tool calls): the running
   * answer is interrupted as soon as one is exceeded. Cost is estimated live from token usage and
   * model prices (the exact figure only arrives with the result).
   */
  #checkLimits() {
    const t = this.turn;
    const lim = this.project?.turnLimits;
    if (!t || !lim || this.limitHit) return;
    const pctPerUsd = this.ctx.limits.forecast?.()?.pctPerUsd5h ?? null;
    const minutes = (Date.now() - t.startedAt) / 60_000;
    const checks = [
      [lim.costUsd > 0 && t.estCost >= lim.costUsd, `Kosten ≈ ${t.estCost.toFixed(2)} $ (Limit ${lim.costUsd} $)`],
      [lim.usagePct > 0 && pctPerUsd != null && t.estCost * pctPerUsd >= lim.usagePct, `≈ ${(t.estCost * (pctPerUsd ?? 0)).toFixed(1)} % des 5-h-Limits (Limit ${lim.usagePct} %)`],
      [lim.minutes > 0 && minutes >= lim.minutes, `Laufzeit ${Math.floor(minutes)} min (Limit ${lim.minutes} min)`],
      [lim.calls > 0 && t.calls >= lim.calls, `${t.calls} Schritte (Limit ${lim.calls})`],
    ];
    const hit = checks.find(([over]) => over);
    if (!hit) return;
    this.limitHit = true;
    this.#log('cockpit', 'limit', { text: `Limit erreicht: ${hit[1]} – Antwort abgebrochen` });
    this.appendContext('limit', `Limit erreicht: ${hit[1]} – Antwort abgebrochen`);
    this.interrupt().catch(() => {}).finally(() => { this.limitHit = false; });
  }

  /** Token usage of one API call → estimated USD (cache reads 0.1×, cache writes 1.25× input price). */
  #estimateCost(model, usage, outDelta, first) {
    const price = this.ctx.catalog?.prices?.[model];
    if (!price) return 0;
    let c = (outDelta * price.out) / 1e6;
    if (first) c += ((usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) * 0.1 + (usage.cache_creation_input_tokens ?? 0) * 1.25) * price.in / 1e6;
    return c;
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
    if (SAFE_BROWSER_TOOLS.has(toolName) || COCKPIT_SAFE_TOOLS.has(toolName)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
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

  /**
   * Access to a resource this project has not been granted yet (another project's database or session,
   * a browser identity …): asks the user in the cockpit – in EVERY permission mode, also auto and
   * bypass, because the check runs inside the cockpit tool itself, not in Claude Code's permission logic.
   * "Immer erlauben" stores the grant in the project (project.grants). Resolves true/false.
   */
  async requestAccess(resource, { title, description }) {
    const p = await this.ctx.projects.get(this.projectId);
    if ((p.grants ?? []).includes(resource)) return true;
    return new Promise((resolve) => {
      const id = uuid();
      const req = {
        id, toolName: 'Zugriff', input: { resource }, title, description, displayName: 'Zugriff', decisionReason: null, blockedPath: null,
        toolUseId: null, agentId: null, mcpServer: null, canAlways: true, defaultToNo: false, access: true, ts: Date.now(),
      };
      this.pending.set(id, { req, input: { resource }, suggestions: [], access: true, resolve: (r) => resolve(r.behavior === 'allow') });
      if (this.state === 'running') this.setState('waiting');
      this.emitStatus();
      this.ctx.hub.toAll({ t: 'notify', projectId: this.projectId, text: title });
    });
  }

  respond(id, decision = {}) {
    const entry = this.pending.get(id);
    if (!entry) throw new UserError('Diese Anfrage ist nicht mehr offen');
    if (entry.access) {
      // cockpit resource access (requestAccess)
      const allow = decision.decision === 'allow' || decision.decision === 'always';
      if (decision.decision === 'always') {
        this.ctx.projects.get(this.projectId).then((p) => this.ctx.projects.touch(this.projectId, { grants: [...new Set([...(p.grants ?? []), entry.input.resource])] })).catch(() => {});
      }
      this.pending.delete(id);
      entry.resolve({ behavior: allow ? 'allow' : 'deny' });
      this.#log('cockpit', 'permission_decision', { id, toolName: `Zugriff ${entry.input.resource}`, decision: decision.decision, message: null });
      if (!this.pending.size && this.state === 'waiting') this.setState('running');
      this.emitStatus();
      return;
    }
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
    let first = false;
    if (!rec) {
      rec = { out: 0 };
      first = true;
      this.seen.set(m.id, rec);
      if (this.seen.size > 4000) this.seen.delete(this.seen.keys().next().value);
      if (!this.turn) this.#beginTurn();
      this.turn.calls++;
      this.stats.apiCalls++;
    }
    const out = u.output_tokens ?? 0;
    const outDelta = Math.max(0, out - rec.out);
    if (out > rec.out) {
      this.stats.outTokens += out - rec.out;
      rec.out = out;
    }
    if (this.turn) this.turn.estCost += this.#estimateCost(m.model, u, outDelta, first);
    this.#checkLimits();
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
    // final answer of the turn – read by parent sessions (session_status / session_wait)
    this.lastResult = { text: String(msg.result ?? '').slice(0, 20_000), isError: !!msg.is_error, at: Date.now(), costUsd: delta };
    if (!msg.local_command && msg.result) this.appendContext('claude', msg.result);
    setImmediate(() => this.#maybeCompact(msg));
    this.ctx.limits.addCost(delta);
    this.turn = null;
    clearInterval(this.limitTimer);
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
    if (this.project.autoCommit !== false && this.lastPrompt && await this.ctx.git.isRepo(this.projectId)) {
      const first = this.lastPrompt.split('\n')[0].slice(0, 72);
      try {
        const c = await this.ctx.git.commit(this.projectId, `Claude: ${first}`, { auto: true });
        if (c) this.#log('cockpit', 'git_commit', { hash: c.short, subject: c.subject });
      } catch (e) { this.#log('cockpit', 'error_note', { text: `Auto-Commit fehlgeschlagen: ${e.message}` }); }
    }
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
