import { isProjectId } from './store.js';
import { UserError, isUuid } from './util.js';

function pid(msg) {
  if (!isProjectId(msg.projectId)) throw new UserError('Ungültige Projekt-ID');
  return msg.projectId;
}

/** WebSocket request handlers. Each returns data for the client's ack. */
export function createActions(ctx) {
  const { runners, projects, sessions, files, auth, terminals, hub, usagePoller, probe } = ctx;

  const actions = {
    hello: () => ctx.helloPayload(),

    subscribe: (msg, client) => {
      const ids = (Array.isArray(msg.projects) ? msg.projects : []).filter(isProjectId).slice(0, 8);
      hub.subscribe(client, ids);
      return null;
    },

    // ---- projects
    'project.create': async (msg) => projects.create(msg.project ?? {}),
    'project.update': async (msg) => {
      const id = pid(msg);
      const updated = await projects.update(id, msg.patch ?? {});
      const r = runners.peek(id);
      if (r) r.project = updated;
      return updated;
    },
    'project.delete': async (msg) => {
      const id = pid(msg);
      for (const t of terminals.list(id)) terminals.close(t.id);
      await runners.drop(id);
      files.unwatch(id);
      return projects.remove(id);
    },

    // ---- sessions
    sessions: (msg) => sessions.list(pid(msg)),
    history: (msg) => sessions.history(pid(msg), msg.sessionId),
    'session.select': async (msg) => {
      const r = await runners.get(pid(msg));
      await r.selectSession(msg.sessionId ?? null);
      return r.snapshot();
    },
    'session.new': async (msg) => {
      const r = await runners.get(pid(msg));
      if (r.live) await r.send('/clear');
      else await r.selectSession(null);
      return r.snapshot();
    },
    'session.fork': async (msg) => {
      if (!isUuid(msg.sessionId)) throw new UserError('Ungültige Session-ID');
      const r = await runners.get(pid(msg));
      if (r.live) await r.stop('switch');
      await r.ensureStarted({ resume: msg.sessionId, fork: true });
      return r.snapshot();
    },

    // ---- runner control
    send: async (msg) => {
      const r = await runners.get(pid(msg));
      await r.send(msg.text);
      return null;
    },
    interrupt: async (msg) => { await runners.peek(pid(msg))?.interrupt(); return null; },
    stop: async (msg) => { await runners.peek(pid(msg))?.stop('user'); return null; },
    start: async (msg) => {
      const r = await runners.get(pid(msg));
      await r.ensureStarted();
      return r.snapshot();
    },
    setModel: async (msg) => { await (await runners.get(pid(msg))).setModel(msg.model); return null; },
    setMode: async (msg) => {
      if (!ctx.config.permissionModes.includes(msg.mode)) throw new UserError('Unbekannter Modus');
      await (await runners.get(pid(msg))).setMode(msg.mode);
      return null;
    },
    setEffort: async (msg) => { await (await runners.get(pid(msg))).setEffort(msg.effort ?? ''); return null; },
    perm: async (msg) => {
      const r = runners.peek(pid(msg));
      if (!r) throw new UserError('Keine aktive Session');
      r.respond(String(msg.id), { decision: msg.decision, message: msg.message, updatedInput: msg.updatedInput, mode: msg.mode });
      return null;
    },
    stopTask: async (msg) => { await runners.peek(pid(msg))?.stopTask(msg.taskId); return null; },
    rewind: async (msg) => {
      const r = runners.peek(pid(msg));
      if (!r) throw new UserError('Keine aktive Session');
      return r.rewind(msg.userMessageId, msg.dryRun);
    },
    context: async (msg) => {
      const r = runners.peek(pid(msg));
      if (!r?.live) throw new UserError('Session läuft nicht');
      return r.contextDetail();
    },
    status: async (msg) => (await runners.get(pid(msg))).snapshot(),

    // ---- usage / catalog
    'usage.refresh': async () => { await usagePoller.fetch(); return ctx.limits.snapshot(); },
    'catalog.refresh': async () => {
      const { usage } = await probe.run({ usage: true });
      if (usage) ctx.limits.ingestUsage(usage);
      return ctx.catalog.snapshot();
    },

    // ---- files
    files: (msg) => files.list(pid(msg), msg.path ?? ''),
    outputs: (msg) => files.recentOutputs(pid(msg)),

    // ---- auth
    'auth.status': () => auth.refresh(),
    'auth.login': (msg) => { auth.startLogin(msg.method === 'console' ? 'console' : 'claudeai'); return null; },
    'auth.code': (msg) => {
      if (!auth.submitCode(msg.code)) throw new UserError('Kein laufender Login oder ungültiger Code');
      return null;
    },
    'auth.cancel': () => { auth.cancelLogin(); return null; },
    'auth.logout': async () => {
      await runners.shutdown();
      return auth.logout();
    },

    // ---- terminals
    'term.list': (msg) => terminals.list(pid(msg)),
    'term.open': (msg) => terminals.open({ projectId: pid(msg), kind: msg.kind === 'claude' ? 'claude' : 'shell', sessionId: msg.sessionId, cols: msg.cols, rows: msg.rows }),
    'term.input': (msg) => { terminals.write(String(msg.id), msg.data); return null; },
    'term.resize': (msg) => { terminals.resize(String(msg.id), msg.cols, msg.rows); return null; },
    'term.replay': (msg) => terminals.replay(String(msg.id)),
    'term.close': (msg) => { terminals.close(String(msg.id)); return null; },
  };

  return async (msg, client) => {
    const fn = actions[msg.t];
    if (!fn) throw new UserError(`Unbekannte Aktion: ${msg.t}`);
    return fn(msg, client);
  };
}
