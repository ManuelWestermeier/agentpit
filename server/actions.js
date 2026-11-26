import { setEnvValue } from './config.js';
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
      const before = await projects.get(id);
      const patch = { ...(msg.patch ?? {}) };
      if (typeof patch.name === 'string' && patch.name.trim() && patch.name.trim() !== before.name) patch.autoTitle = false; // named by the user
      const updated = await projects.update(id, patch);
      const r = runners.peek(id);
      if (r) {
        r.project = updated;
        // identity changed while a session runs → Claude's browser follows right away
        if (before.browserProfile !== updated.browserProfile) await r.browserChanged();
      }
      return updated;
    },
    'project.delete': async (msg) => {
      const id = pid(msg);
      for (const t of terminals.list(id)) terminals.close(t.id);
      await runners.drop(id);
      await ctx.schedules.dropProject(id).catch(() => {});
      await ctx.browsers.dropIsolated(id).catch(() => {});
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
    'env.install': (msg) => { ctx.installer.start(String(msg.key)); return null; },
    'svc.listAll': () => ctx.services.listAll(),
    'cleanup.run': () => ctx.janitor.run(),
    'cleanup.last': () => ctx.janitor.last,
    'schedules.list': (msg) => ctx.schedules.list(msg.projectId ? pid(msg) : undefined),
    'schedules.create': (msg) => ctx.schedules.create(pid(msg), msg.schedule ?? {}, 'Nutzer'),
    'schedules.update': (msg) => ctx.schedules.update(String(msg.id), msg.patch ?? {}),
    'schedules.remove': async (msg) => { await ctx.schedules.remove(String(msg.id)); return null; },
    'schedules.run': async (msg) => { await ctx.schedules.runNow(String(msg.id)); return null; },
    'browsers.fack': (msg, client) => { ctx.browsers.frameAck(String(msg.id), client, Number(msg.seq)); return null; },
    'browsers.stream': (msg) => ctx.browsers.setStream(String(msg.id), msg.stream ?? {}),
    'browsers.resize': async (msg) => { await ctx.browsers.resize(String(msg.id), msg.width, msg.height); return null; },
    'browsers.dialog': async (msg) => { await ctx.browsers.answerDialog(String(msg.id), !!msg.accept, msg.text); return null; },
    'browsers.install': () => { ctx.browsers.installBrowsers(); return null; },
    'browsers.fedcm': async (msg) => { await ctx.browsers.answerFedCm(String(msg.id), { action: String(msg.action ?? ''), index: msg.index }); return null; },
    // sound out: the extension's tab capture (every OS), else PulseAudio on Linux
    // sound out: tab capture through the extension on every OS; the viewer says what it can play
    'browsers.audio': (msg, client) => ctx.bridge.listen(String(msg.id), client, msg.on !== false, msg.codec === 'mp4' ? 'mp4' : 'webm'),
    'browsers.restart': async (msg) => { const id = String(msg.id); await ctx.browsers.stop(id); await ctx.browsers.start(id); return null; },
    // microphone in: a real PulseAudio microphone where available (Linux), else through the extension
    'browsers.mic': async (msg, client) => {
      const id = String(msg.id);
      if (msg.on === false) { ctx.audio.micOff(id); ctx.bridge.device(id, client, 'mic', false); return null; }
      if (await ctx.audio.available()) { await ctx.audio.micOn(id, client); return { via: 'pulse' }; }
      ctx.bridge.device(id, client, 'mic', true);
      return { via: 'bridge' };
    },
    'browsers.cam': (msg, client) => { ctx.bridge.device(String(msg.id), client, 'cam', msg.on !== false); return null; },
    'browsers.select': (msg) => { ctx.bridge.choose(String(msg.id), msg.sel, msg.index); return null; },
    'browsers.drop': async (msg) => { await ctx.browsers.dropFiles(String(msg.id), msg); return null; },
    'browsers.files': async (msg) => { await ctx.browsers.chooseFiles(String(msg.id), msg.files ?? []); return null; },

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
    allowAll: async (msg) => {
      const r = runners.peek(pid(msg));
      if (!r) throw new UserError('Keine aktive Session');
      await r.allowAll();
      return null;
    },
    /** Unlock / lock "Alles erlauben" (bypassPermissions): applies now and is kept in .env. */
    'config.allowBypass': async (msg) => {
      const on = msg.on === true;
      setEnvValue('ALLOW_BYPASS_PERMISSIONS', on ? 'true' : 'false');
      ctx.config.allowBypass = on;
      if (!on) {
        for (const r of runners.map.values()) if (r.mode === 'bypassPermissions') await r.setMode('acceptEdits').catch(() => {});
      }
      hub.toAll({ t: 'config', patch: { allowBypass: on } });
      return null;
    },
    // ---- remote access (Cloudflare Tunnel) and server health
    'tunnel.start': (msg) => ctx.tunnel.start(msg.mode === 'token' ? 'token' : msg.mode === 'quick' ? 'quick' : undefined),
    'tunnel.stop': () => { ctx.tunnel.stop(); return ctx.tunnel.snapshot(); },
    'tunnel.install': async () => { await ctx.tunnel.install(); return ctx.tunnel.snapshot(); },
    'monitor.get': () => ctx.monitor.last,

    // ---- browser users (own page /u/<name>, only their identities)
    'users.list': () => ({ users: ctx.security.users.list(), admin: ctx.security.adminName() }),
    'users.create': async (msg) => {
      const name = String(msg.name ?? '').trim().toLowerCase();
      if (name === ctx.security.adminName()) throw new UserError('Der Name gehört dem Admin.');
      let browsers = (Array.isArray(msg.browsers) ? msg.browsers : []).map(String).filter((id) => ctx.browsers.profiles.has(id));
      ctx.security.users.create({ name, password: msg.password, browsers: [] }, [ctx.security.adminName()]); // validates first
      if (msg.ownBrowser !== false) browsers = [(await ctx.browsers.create({ name: `Nutzer ${name}`, owner: name })).id, ...browsers];
      ctx.security.users.setBrowsers(name, browsers);
      return { users: ctx.security.users.list() };
    },
    'users.password': (msg) => {
      const name = String(msg.name ?? '');
      ctx.security.users.setPassword(name, msg.password);
      ctx.security.dropUserSessions(name);
      ctx.enforceSessions();
      return { users: ctx.security.users.list() };
    },
    'users.browsers': (msg) => {
      const ids = (Array.isArray(msg.browsers) ? msg.browsers : []).map(String).filter((id) => ctx.browsers.profiles.has(id));
      ctx.security.users.setBrowsers(String(msg.name ?? ''), ids);
      for (const c of hub.clients) if (c.user === msg.name) ctx.helloPayload(c).then((h) => hub.send(c, { t: 'hello', ...h }));
      return { users: ctx.security.users.list() };
    },
    'users.remove': (msg) => {
      const name = String(msg.name ?? '');
      ctx.security.users.remove(name);
      ctx.security.dropUserSessions(name);
      ctx.enforceSessions();
      return { users: ctx.security.users.list() };
    },
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
    ctx.access.check(msg, client); // browser users: only their own identities
    return fn(msg, client);
  };
}
