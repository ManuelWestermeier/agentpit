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
    hello: (_msg, client) => ctx.helloPayload(client),

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

    // ---- browser profiles
    'browsers.list': () => ({ profiles: ctx.browsers.list(), status: ctx.browsers.status() }),
    'browsers.create': (msg) => ctx.browsers.create(msg.profile ?? {}),
    'browsers.update': (msg) => ctx.browsers.update(String(msg.id), msg.patch ?? {}),
    'browsers.remove': async (msg) => { await ctx.browsers.remove(String(msg.id)); return null; },
    'browsers.start': async (msg) => { await ctx.browsers.start(String(msg.id)); return null; },
    'browsers.stop': async (msg) => { await ctx.browsers.stop(String(msg.id)); return null; },
    'browsers.view': async (msg, client) => { await ctx.browsers.view(String(msg.id), client, msg.on !== false); return null; },
    'browsers.input': async (msg) => { await ctx.browsers.input(String(msg.id), msg.ev ?? {}); return null; },
    'browsers.nav': async (msg) => { await ctx.browsers.navigate(String(msg.id), msg); return null; },
    'browsers.tab': async (msg) => { await ctx.browsers.tab(String(msg.id), msg); return null; },
    'browsers.fack': (msg, client) => { ctx.browsers.frameAck(String(msg.id), client, Number(msg.seq)); return null; },
    'browsers.stream': (msg) => ctx.browsers.setStream(String(msg.id), msg.stream ?? {}),
    'browsers.resize': async (msg) => { await ctx.browsers.resize(String(msg.id), msg.width, msg.height); return null; },
    'browsers.dialog': async (msg) => { await ctx.browsers.answerDialog(String(msg.id), !!msg.accept, msg.text); return null; },
    'browsers.install': () => { ctx.browsers.installBrowsers(); return null; },

    // ---- git
    'git.status': (msg) => ctx.git.status(pid(msg)),
    'git.init': (msg) => ctx.git.init(pid(msg)),
    'git.diff': (msg) => ctx.git.diff(pid(msg), msg.file ?? null),
    'git.show': (msg) => ctx.git.show(pid(msg), msg.hash),
    'git.commit': (msg) => ctx.git.commit(pid(msg), msg.message),
    'git.discard': async (msg) => { await ctx.git.discard(pid(msg), String(msg.file ?? '')); return null; },
    'git.revert': async (msg) => { await ctx.git.revert(pid(msg), msg.hash); return null; },
    'git.push': (msg) => ctx.git.push(pid(msg)),
    'git.pull': (msg) => ctx.git.pull(pid(msg)),
    'git.remote': (msg) => ctx.git.setRemote(pid(msg), msg.url),
    'git.publish': async (msg) => {
      const id = pid(msg);
      if (!(await ctx.git.isRepo(id))) await ctx.git.init(id);
      await ctx.git.commit(id, 'Stand vor Veröffentlichung', { auto: true });
      await ctx.github.publish(projects.dirOf(id), msg.name, msg.private !== false);
      return ctx.git.status(id);
    },

    // ---- GitHub
    // ---- access protection (password, devices, trusted addresses)
    'security.status': (_msg, client) => ctx.security.status(client.session),
    'security.setPassword': (msg, client) => {
      ctx.security.setPassword({ password: msg.password, current: msg.current, sessionId: client.session, ip: client.ip });
      hub.toAll({ t: 'security', hasPassword: true });
      ctx.enforceSessions();
      return ctx.security.status(client.session);
    },
    'security.revoke': (msg, client) => { ctx.security.revokeSession(String(msg.id ?? ''), client.session); ctx.enforceSessions(); return ctx.security.status(client.session); },
    'security.revokeOthers': (_msg, client) => { ctx.security.revokeOthers(client.session); ctx.enforceSessions(); return ctx.security.status(client.session); },
    'security.removeHost': (msg, client) => { ctx.security.removeHost(String(msg.host ?? '')); ctx.enforceSessions(); return ctx.security.status(client.session); },
    'security.rotateToken': (_msg, client) => {
      if (!client.local) throw new UserError('Nur lokal am Server möglich.');
      ctx.security.rotateToken();
      return { link: `${ctx.localUrl.replace('127.0.0.1', 'localhost')}/?token=${ctx.security.token}` };
    },

    'github.status': () => ctx.github.refresh(),
    'github.login': () => { ctx.github.startDeviceLogin(); return null; },
    'github.token': (msg) => ctx.github.tokenLogin(msg.token),
    'github.cancel': () => { ctx.github.cancel(); return null; },
    'github.logout': () => ctx.github.logout(),

    // ---- databases
    'db.list': (msg) => ctx.databases.list(pid(msg)),
    'db.save': (msg) => ctx.databases.save(pid(msg), msg.conn ?? {}),
    'db.remove': async (msg) => { await ctx.databases.remove(pid(msg), String(msg.id)); return null; },
    'db.query': (msg) => ctx.databases.run(pid(msg), String(msg.id), msg.sql, msg.write ? 'write' : 'read'),
    'db.schema': (msg) => ctx.databases.schema(pid(msg), String(msg.id)),

    // ---- services
    'svc.list': (msg) => ctx.services.list(pid(msg)),
    'svc.save': (msg) => ctx.services.save(pid(msg), msg.service ?? {}),
    'svc.remove': async (msg) => { await ctx.services.remove(pid(msg), String(msg.id)); return null; },
    'svc.start': async (msg) => { await ctx.services.start(pid(msg), String(msg.id)); return null; },
    'svc.stop': async (msg) => { await ctx.services.stop(pid(msg), String(msg.id)); return null; },
    'svc.restart': async (msg) => { await ctx.services.restart(pid(msg), String(msg.id)); return null; },
    'svc.logs': (msg) => ctx.services.logs(pid(msg), String(msg.id), 1000),
    'project.hook': async (msg) => {
      const p = await projects.get(pid(msg));
      return { url: `${ctx.localUrl}/api/hook/${p.id}`, publicUrl: ctx.config.publicUrls[0] ? `${ctx.config.publicUrls[0]}/api/hook/${p.id}` : null, token: p.hookToken };
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
