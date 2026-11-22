import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { isUuid } from './util.js';

/**
 * Session list per project = Claude Code's own transcripts (also sessions started in a terminal)
 * merged with the cockpit's event logs. History prefers the cockpit log (complete, survives
 * /compact, contains costs and approvals) and falls back to the transcript.
 */
export class Sessions {
  constructor(ctx) {
    this.ctx = ctx;
    this.timers = new Map();
  }

  invalidate(projectId) {
    clearTimeout(this.timers.get(projectId));
    this.timers.set(projectId, setTimeout(async () => {
      this.timers.delete(projectId);
      try {
        const sessions = await this.list(projectId);
        this.ctx.hub.toProject(projectId, { t: 'sessions', projectId, sessions });
      } catch (e) { console.warn(`[sessions] ${e.message}`); }
    }, 600));
  }

  async list(projectId) {
    const { projects, store } = this.ctx;
    const dir = projects.dirOf(projectId);
    let sdk = [];
    try { sdk = await listSessions({ dir, includeWorktrees: false }); } catch { /* no transcripts yet */ }
    const logs = await store.listLogs(projectId);
    const map = new Map();
    for (const s of sdk) {
      if (!isUuid(s.sessionId)) continue;
      map.set(s.sessionId, {
        sessionId: s.sessionId,
        title: s.customTitle || s.summary || s.firstPrompt || null,
        lastModified: s.lastModified ?? 0,
        createdAt: s.createdAt ?? null,
        hasTranscript: true,
        hasLog: false,
      });
    }
    for (const l of logs) {
      const e = map.get(l.sessionId) ?? { sessionId: l.sessionId, title: null, lastModified: 0, createdAt: null, hasTranscript: false };
      e.hasLog = true;
      e.lastModified = Math.max(e.lastModified, l.mtime);
      map.set(l.sessionId, e);
    }
    const rows = [...map.values()].sort((a, b) => b.lastModified - a.lastModified).slice(0, 150);
    await Promise.all(rows.map(async (e) => {
      const st = await store.readStats(projectId, e.sessionId);
      if (st) {
        e.costUsd = st.costUsd;
        e.turns = st.turns;
        e.forkedFrom = st.forkedFrom ?? null;
        e.title = st.title || e.title || st.firstPrompt; // Haiku title first (server/meta.js)
        e.createdAt = e.createdAt ?? st.createdAt;
      }
      e.title = e.title || 'Neue Session';
    }));
    return rows;
  }

  async history(projectId, sessionId) {
    const { store, config, media, projects } = this.ctx;
    if (!isUuid(sessionId)) return { source: 'none', events: [], total: 0, truncated: false };
    const own = await store.readEvents(projectId, sessionId, config.historyLimit);
    if (own) {
      // A fork starts with the parent's conversation: show it first (one level).
      const started = own.events.find((e) => e.type === 'cockpit' && e.subtype === 'runner_started');
      if (started?.forkedFrom && isUuid(started.forkedFrom) && own.events.length < config.historyLimit) {
        const parent = await store.readEvents(projectId, started.forkedFrom, config.historyLimit - own.events.length);
        if (parent) {
          const marker = { type: 'cockpit', subtype: 'fork_marker', from: started.forkedFrom, _ts: started._ts };
          return { source: 'cockpit', events: [...parent.events, marker, ...own.events], total: parent.total + own.total, truncated: parent.truncated || own.truncated };
        }
      }
      return { source: 'cockpit', ...own };
    }
    let msgs = [];
    try {
      msgs = await getSessionMessages(sessionId, { dir: projects.dirOf(projectId), includeSystemMessages: true });
    } catch (e) {
      return { source: 'none', events: [], total: 0, truncated: false, error: e.message };
    }
    const total = msgs.length;
    if (msgs.length > config.historyLimit) msgs = msgs.slice(-config.historyLimit);
    const events = await media.sanitize(msgs);
    return { source: 'transcript', events, total, truncated: total > events.length };
  }
}
