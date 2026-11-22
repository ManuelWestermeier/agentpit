import { create } from 'zustand';
import { Timeline } from './timeline';
import type { AuthSnapshot, BrowsersState, Catalog, GitHubSnapshot, Hello, HistoryResult, Limits, Project, RunnerStatus, Schedule, ServiceInfo, SessionInfo } from './types';
import { conn } from './ws';

export type Filter = 'all' | 'chat' | 'commands';
export type Tab = 'session' | 'browser' | 'files' | 'git' | 'services' | 'data';

interface View {
  projectId: string;
  sessionId: string | null;
  follow: boolean;          // follows the runner's live session
  timeline: Timeline;
  version: number;
  loading: boolean;
  truncated: boolean;
  total: number;
  buffer: any[];            // live events that arrive while history is loading
}

interface Toast { id: number; level: 'info' | 'warn' | 'error'; text: string }

interface State {
  connected: boolean;
  hello: Hello | null;
  projects: Project[];
  runners: Record<string, RunnerStatus>;
  auth: AuthSnapshot | null;
  catalog: Catalog | null;
  limits: Limits | null;
  activeId: string | null;
  sessions: Record<string, SessionInfo[]>;
  view: View | null;
  live: { text: string; thinking: string };
  progress: Record<string, number>;
  filesVersion: number;
  filter: Filter;
  tab: Tab;
  profileView: string | null;
  browsers: BrowsersState | null;
  github: GitHubSnapshot | null;
  services: Record<string, ServiceInfo[]>;
  schedules: Schedule[];
  usageOpen: boolean;
  preview: { path: string; at: number } | null;
  toasts: Toast[];
  loginOpen: boolean;
  draft: Record<string, string>;

  init(): void;
  selectProject(id: string | null): Promise<void>;
  openSession(projectId: string, sessionId: string | null, follow: boolean): Promise<void>;
  toast(level: Toast['level'], text: string): void;
  set(p: Partial<State>): void;
}

const LS_ACTIVE = 'cockpit.active';
const storage = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let toastSeq = 0;

export const useStore = create<State>()((set, get) => {
  const bumpView = () => {
    const v = get().view;
    if (v) set({ view: { ...v, version: v.timeline.version } });
  };

  const newView = (projectId: string, sessionId: string | null, follow: boolean): View => ({
    projectId, sessionId, follow, timeline: new Timeline('cockpit'), version: 0, loading: false, truncated: false, total: 0, buffer: [],
  });

  function onMessage(msg: any) {
    const s = get();
    switch (msg.t) {
      case 'hello': {
        const h = msg as Hello & { t: string };
        set({ hello: h, projects: h.projects, runners: h.runners, auth: h.auth, catalog: h.catalog, limits: h.limits, browsers: h.browsers, github: h.github, schedules: h.schedules ?? [] });
        const remembered = s.activeId ?? storage.get(LS_ACTIVE);
        const pick = h.projects.find((p) => p.id === remembered)?.id ?? h.projects[0]?.id ?? null;
        get().selectProject(pick);
        return;
      }
      case 'projects': {
        set({ projects: msg.projects });
        if (s.activeId && !msg.projects.some((p: Project) => p.id === s.activeId)) get().selectProject(msg.projects[0]?.id ?? null);
        return;
      }
      case 'runner': {
        const st: RunnerStatus = msg.status;
        const prev = s.runners[msg.projectId];
        set({ runners: { ...s.runners, [msg.projectId]: st } });
        const v = get().view;
        if (v && v.projectId === msg.projectId && v.follow && st.sessionId !== v.sessionId) {
          // Runner moved to another session (new session, /clear, fork) – follow it
          if (st.sessionId === null || !prev || prev.sessionId !== st.sessionId) {
            set({ view: newView(msg.projectId, st.sessionId, true), live: { text: '', thinking: '' } });
          }
        }
        return;
      }
      case 'ev': {
        const v = s.view;
        if (!v || v.projectId !== msg.projectId) return;
        if (v.sessionId !== msg.sessionId) {
          if (!v.follow) return;
          const nv = newView(msg.projectId, msg.sessionId, true);
          nv.timeline.ingest(msg.ev);
          set({ view: { ...nv, version: nv.timeline.version } });
          return;
        }
        const ev = msg.ev;
        if (v.loading) { v.buffer.push(ev); return; }
        v.timeline.ingest(ev);
        if (ev.type === 'assistant') {
          const types = (ev.message?.content ?? []).map((b: any) => b?.type);
          const live = { ...get().live };
          if (types.includes('text')) live.text = '';
          if (types.includes('thinking') || types.includes('redacted_thinking')) live.thinking = '';
          set({ live });
        } else if (ev.type === 'result') set({ live: { text: '', thinking: '' }, progress: {} });
        bumpView();
        return;
      }
      case 'live': {
        if (msg.projectId !== s.activeId) return;
        switch (msg.k) {
          case 'stream':
            set({ live: { text: s.live.text + (msg.text ?? ''), thinking: s.live.thinking + (msg.thinking ?? '') } });
            return;
          case 'stream_reset':
            set({ live: { text: '', thinking: '' } });
            return;
          case 'tool_progress':
            set({ progress: { ...s.progress, [msg.toolUseId]: msg.elapsed } });
            return;
          case 'cmd':
            if (s.view?.follow) { s.view.timeline.markCommand(msg.uuid, msg.state); bumpView(); }
            return;
          case 'perm_done':
            return;
          default:
            return;
        }
      }
      case 'sessions':
        set({ sessions: { ...s.sessions, [msg.projectId]: msg.sessions } });
        return;
      case 'files':
        if (msg.projectId === s.activeId) set({ filesVersion: s.filesVersion + 1 });
        return;
      case 'auth':
        set({ auth: msg.auth });
        if (msg.auth?.login?.state === 'done') get().toast('info', 'Angemeldet.');
        return;
      case 'catalog':
        set({ catalog: msg.catalog });
        return;
      case 'browsers':
        set({ browsers: msg.browsers });
        if (s.profileView && !msg.browsers.profiles.some((p: { id: string }) => p.id === s.profileView)) set({ profileView: null });
        return;
      case 'binstall':
        if (s.browsers) set({ browsers: { ...s.browsers, status: { ...s.browsers.status, install: msg.install } } });
        return;
      case 'schedules':
        set({ schedules: msg.schedules ?? [] });
        return;
      case 'env':
        if (s.hello) set({ hello: { ...s.hello, env: msg.env, installs: msg.installs } });
        return;
      case 'github':
        set({ github: msg.github });
        if (msg.github?.login?.state === 'done' && s.github?.login?.state === 'running') get().toast('info', 'Mit GitHub verbunden.');
        return;
      case 'services':
        set({ services: { ...s.services, [msg.projectId]: msg.services } });
        return;
      case 'limits':
        set({ limits: msg.limits });
        return;
      case 'security':
        if (s.hello) set({ hello: { ...s.hello, config: { ...s.hello.config, hasPassword: !!msg.hasPassword } } });
        return;
      case 'attention': {
        const p = s.projects.find((x) => x.id === msg.projectId);
        const text = `${p?.name ?? msg.projectId}: Freigabe nötig${msg.title ? ` – ${msg.title}` : ''}`;
        if (msg.projectId !== s.activeId || document.hidden) {
          get().toast('warn', text);
          try {
            if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification('Cockpit', { body: text });
          } catch { /* not supported */ }
        }
        return;
      }
      default:
        return;
    }
  }

  return {
    connected: false,
    hello: null,
    projects: [],
    runners: {},
    auth: null,
    catalog: null,
    limits: null,
    activeId: null,
    sessions: {},
    view: null,
    live: { text: '', thinking: '' },
    progress: {},
    filesVersion: 0,
    filter: 'all',
    tab: 'session',
    profileView: null,
    browsers: null,
    github: null,
    services: {},
    schedules: [],
    usageOpen: false,
    preview: null,
    toasts: [],
    loginOpen: false,
    draft: {},

    set: (p) => set(p),

    init() {
      conn.onMessage(onMessage);
      conn.onStatus((up) => {
        set({ connected: up });
        if (!up) return;
        const id = get().activeId;
        if (id) conn.send('subscribe', { projects: [id] });
      });
      conn.connect();
    },

    async selectProject(id) {
      storage.set(LS_ACTIVE, id);
      set({ activeId: id, profileView: null, live: { text: '', thinking: '' }, progress: {}, preview: null });
      conn.send('subscribe', { projects: id ? [id] : [] });
      if (!id) { set({ view: null }); return; }
      const project = get().projects.find((p) => p.id === id);
      const runner = get().runners[id];
      const sessionId = runner?.sessionId ?? project?.lastSessionId ?? null;
      conn.call<SessionInfo[]>('sessions', { projectId: id }).then((list) => set({ sessions: { ...get().sessions, [id]: list } })).catch(() => {});
      await get().openSession(id, sessionId, true);
    },

    async openSession(projectId, sessionId, follow) {
      const view = newView(projectId, sessionId, follow);
      view.loading = !!sessionId;
      set({ view, live: { text: '', thinking: '' }, progress: {} });
      if (!sessionId) return;
      try {
        const h = await conn.call<HistoryResult>('history', { projectId, sessionId }, 120_000);
        const cur = get().view;
        if (cur?.projectId !== projectId || cur.sessionId !== sessionId) return;
        const tl = new Timeline(h.source);
        tl.ingestAll(h.events);
        // Replay live events that arrived during loading and are not in the history yet
        const seen = new Set(h.events.map((e) => e.uuid).filter(Boolean));
        for (const ev of cur.buffer) if (!ev.uuid || !seen.has(ev.uuid)) tl.ingest(ev);
        set({ view: { ...cur, timeline: tl, version: tl.version, loading: false, truncated: h.truncated, total: h.total, buffer: [] } });
      } catch (e) {
        const cur = get().view;
        if (cur?.sessionId === sessionId) {
          for (const ev of cur.buffer) cur.timeline.ingest(ev);
          set({ view: { ...cur, loading: false, buffer: [], version: cur.timeline.version } });
        }
        get().toast('error', `Verlauf konnte nicht geladen werden: ${(e as Error).message}`);
      }
    },

    toast(level, text) {
      const id = ++toastSeq;
      set({ toasts: [...get().toasts, { id, level, text }].slice(-4) });
      setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), level === 'error' ? 9000 : 5000);
    },
  };
});

/** Helper for actions that should report failures as a toast. */
/**
 * New project in one click: no name, no options. Claude Haiku names it from the first prompt
 * (server/meta.js); model, mode and browser come from the defaults and can be changed in settings.
 */
export async function newProject() {
  const p = await act(() => conn.call<Project>('project.create', { project: { name: 'Neues Projekt' } }));
  if (!p) return;
  const st = useStore.getState();
  if (!st.projects.some((x) => x.id === p.id)) useStore.setState({ projects: [p, ...st.projects] });
  useStore.setState({ tab: 'session', profileView: null });
  await st.selectProject(p.id);
  setTimeout(() => (document.querySelector('.composer textarea') as HTMLTextAreaElement | null)?.focus(), 50);
}

export async function act<T>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (okText) useStore.getState().toast('info', okText);
    return r;
  } catch (e) {
    useStore.getState().toast('error', (e as Error).message);
    return undefined;
  }
}
