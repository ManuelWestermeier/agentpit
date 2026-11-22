import { query } from '@anthropic-ai/claude-agent-sdk';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_PROMPTS = 30;     // remembered per project (newest kept)
const PROMPT_CHARS = 500;   // per prompt sent to the namer
const MIN_GAP_MS = 20_000;  // at most one naming call per project in this interval

const SYSTEM = `Du benennst Arbeitsprojekte in einem Werkzeug, in dem ein Nutzer Claude Aufgaben gibt.
Antworte ausschließlich mit einem JSON-Objekt, ohne Erklärung, ohne Codeblock.`;

/** Strips routing headers the cockpit adds ("[Nachricht von …]", "[Zeitplan …]"). */
const clean = (t) => String(t).replace(/^\[(Nachricht|Aufgabe) von [^\]]*\]\s*|^\[Zeitplan [^\]]*\]\s*/u, '').trim().slice(0, PROMPT_CHARS);

/** One line of text: no quotes, emoji, trailing dot; max length. */
function tidy(s, max) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/^["'„“»«\s]+|["'„“»«\s.]+$/g, '').replace(/\p{Extended_Pictographic}/gu, '').trim().slice(0, max);
}

/**
 * Titles and descriptions written by Claude Haiku from the user's prompts:
 * project title + one-sentence description (data, UI, META.md in the project folder) and a short
 * title per session. Runs on the first prompts of a session and then every 5th prompt, never
 * blocks a prompt, and keeps a title that still fits. A project the user renamed keeps its name.
 */
export class Meta {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = new Map();   // projectId → { prompts, sessionCounts, running, again, lastRun }
  }

  #file(projectId) { return this.ctx.store.p('meta', `${projectId}.json`); }

  async #load(projectId) {
    let s = this.state.get(projectId);
    if (!s) {
      const saved = await this.ctx.store.readJson(this.#file(projectId), null);
      s = { prompts: saved?.prompts ?? [], sessionCounts: saved?.sessionCounts ?? {}, sessions: saved?.sessions ?? {}, running: null, again: false, lastRun: 0 };
      this.state.set(projectId, s);
    }
    return s;
  }

  /** Called for every user prompt (not for slash commands). Never throws, never blocks. */
  onPrompt(projectId, sessionId, text) {
    if (process.env.COCKPIT_MOCK === '1' || !text?.trim()) return;
    this.#onPrompt(projectId, sessionId, text).catch((e) => console.warn(`[titel] ${projectId}: ${e.message}`));
  }

  async #onPrompt(projectId, sessionId, text) {
    const s = await this.#load(projectId);
    s.prompts.push({ sessionId, text: clean(text), ts: Date.now() });
    if (s.prompts.length > MAX_PROMPTS) s.prompts.splice(0, s.prompts.length - MAX_PROMPTS);
    const n = (s.sessionCounts[sessionId] = (s.sessionCounts[sessionId] ?? 0) + 1);
    await this.#persist(projectId, s);
    // first two prompts of a session shape its title; afterwards every 5th prompt refreshes
    if (n <= 2 || n % 5 === 0) this.#schedule(projectId, sessionId);
  }

  #schedule(projectId, sessionId) {
    const s = this.state.get(projectId);
    if (s.running) { s.again = sessionId; return; }
    const wait = Math.max(0, s.lastRun + MIN_GAP_MS - Date.now());
    s.running = new Promise((r) => setTimeout(r, wait))
      .then(() => this.generate(projectId, sessionId))
      .catch((e) => console.warn(`[titel] ${projectId}: ${e.message}`))
      .finally(() => {
        s.running = null;
        s.lastRun = Date.now();
        if (s.again) { const sid = s.again; s.again = false; this.#schedule(projectId, sid); }
      });
  }

  /** Asks Haiku for title/description/session title and applies them. Returns the parsed answer. */
  async generate(projectId, sessionId) {
    const s = await this.#load(projectId);
    const project = await this.ctx.projects.get(projectId);
    const own = s.prompts.filter((p) => p.sessionId === sessionId).slice(-6);
    const all = s.prompts.slice(-12);
    const input = `Bisheriger Projekttitel: ${project.autoTitle === false ? `${project.name} (vom Nutzer gesetzt, nicht ändern)` : project.name}
Bisherige Beschreibung: ${project.description || '–'}
Bisheriger Session-Titel: ${s.sessions[sessionId] || '–'}

Prompts im ganzen Projekt (älteste zuerst):
${all.map((p, i) => `${i + 1}. ${p.text}`).join('\n')}

Prompts der aktuellen Session:
${own.map((p, i) => `${i + 1}. ${p.text}`).join('\n')}

Gib zurück: {"titel": "…", "beschreibung": "…", "session": "…"}
- titel: 2–5 Wörter, worum es im Projekt geht. Konkret (Gegenstand, nicht Tätigkeit wie „Projekt“, „Aufgabe“, „Hilfe“).
- beschreibung: ein Satz, höchstens 140 Zeichen, was hier entsteht oder erledigt wird.
- session: 2–6 Wörter, worum es in der aktuellen Session geht.
- Sprache der Prompts. Keine Anführungszeichen, keine Emojis, kein Punkt am Ende von titel/session.
- Passt der bisherige Titel noch, gib ihn unverändert zurück.`;

    const text = await this.#ask(input);
    const json = /\{[\s\S]*\}/.exec(text)?.[0];
    if (!json) throw new Error('keine JSON-Antwort');
    const r = JSON.parse(json);
    const title = tidy(r.titel, 60);
    const description = tidy(r.beschreibung, 160).replace(/([^.!?])$/, '$1.');
    const session = tidy(r.session, 60);

    const patch = {};
    if (title && project.autoTitle !== false && title !== project.name) patch.name = title;
    if (description && description !== project.description) patch.description = description;
    if (Object.keys(patch).length) await this.ctx.projects.touch(projectId, patch);
    if (session && sessionId) {
      s.sessions[sessionId] = session;
      await this.#persist(projectId, s);
      await this.#setSessionTitle(projectId, sessionId, session);
    }
    await this.#writeMetaMd(projectId);
    return { title, description, session };
  }

  async #ask(input) {
    const { config } = this.ctx;
    const q = (this.ctx.metaQuery ?? query)({
      prompt: input,
      options: {
        model: 'haiku',
        maxTurns: 1,
        tools: [],                 // naming only – no tools, no file access
        settingSources: [],        // no CLAUDE.md / project settings
        persistSession: false,     // no transcript in ~/.claude
        systemPrompt: SYSTEM,
        cwd: this.ctx.store.p('meta'),
        pathToClaudeCodeExecutable: config.claudeBin || undefined,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'agent-cockpit/1.0 (titles)' },
      },
    });
    let out = '';
    for await (const m of q) {
      if (m.type === 'result') { if (m.is_error) throw new Error(String(m.result ?? m.subtype).slice(0, 200)); out = String(m.result ?? ''); }
    }
    return out;
  }

  async #setSessionTitle(projectId, sessionId, title) {
    const r = this.ctx.runners?.peek(projectId);
    if (r?.stats && r.sessionId === sessionId) {
      r.stats.title = title;      // the runner owns this stats file while it runs
      r.saveStats();
    } else {
      const st = await this.ctx.store.readStats(projectId, sessionId);
      if (st) await this.ctx.store.writeStats(projectId, sessionId, { ...st, title });
    }
    this.ctx.sessions?.invalidate(projectId);
  }

  /** META.md in the project folder: title, description, sessions – readable for people and Claude. */
  async #writeMetaMd(projectId) {
    const project = await this.ctx.projects.get(projectId);
    const s = await this.#load(projectId);
    const sessions = Object.entries(s.sessions)
      .map(([sid, title]) => ({ title, ts: s.prompts.find((p) => p.sessionId === sid)?.ts ?? 0 }))
      .sort((a, b) => b.ts - a.ts);
    const md = `# ${project.name}

${project.description ?? ''}
${sessions.length ? `\n## Sessions\n\n${sessions.map((x) => `- ${x.ts ? new Date(x.ts).toISOString().slice(0, 10) : ''} ${x.title}`.trim()).join('\n')}\n` : ''}
<!-- Vom Agent Cockpit aus den Prompts gepflegt (Claude Haiku). Wird überschrieben. -->
`;
    await fsp.writeFile(path.join(project.dir, 'META.md'), md);
  }

  async #persist(projectId, s) {
    await this.ctx.store.writeJson(this.#file(projectId), { prompts: s.prompts, sessionCounts: s.sessionCounts, sessions: s.sessions });
  }
}
