import { GitFork, LogIn, Plus, SquarePen } from 'lucide-react';
import { useNow } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import { STATE_LABEL, fmtAgo, fmtUsd, shortModel } from '../lib/format';
import type { Project, RunnerStatus, SessionInfo } from '../lib/types';
import { conn } from '../lib/ws';

function stateOf(r: RunnerStatus | undefined) {
  if (!r) return 'idle';
  if (r.pending?.length) return 'waiting';
  return r.state;
}

export function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const hello = useStore((s) => s.hello)!;
  const projects = useStore((s) => s.projects);
  const runners = useStore((s) => s.runners);
  const activeId = useStore((s) => s.activeId);
  const selectProject = useStore((s) => s.selectProject);
  useNow(30_000);

  return (
    <aside className="sidebar" aria-label="Projekte">
      <div className="brand">
        <span className="brand-mark" aria-hidden><i /><b /><b /><b /></span>
        <span className="brand-name">Cockpit</span>
        <span className="brand-ver">{hello.version}</span>
      </div>
      <div className="side-head">
        <span>Projekte</span>
        <button className="btn ghost small" onClick={() => useStore.setState({ newProjectOpen: true })}>
          <Plus size={13} /> Neu
        </button>
      </div>
      <div className="side-scroll">
        <div className="side-section">
          {projects.map((p) => (
            <div key={p.id}>
              <ProjectRow
                project={p}
                runner={runners[p.id]}
                active={p.id === activeId}
                onClick={() => { selectProject(p.id); onNavigate(); }}
              />
              {p.id === activeId && <SessionList project={p} runner={runners[p.id]} />}
            </div>
          ))}
        </div>
      </div>
      <SideFoot />
    </aside>
  );
}

function ProjectRow({ project, runner, active, onClick }: { project: Project; runner?: RunnerStatus; active: boolean; onClick: () => void }) {
  const st = stateOf(runner);
  const meta = runner?.pending?.length
    ? `${runner.pending.length} Freigabe${runner.pending.length > 1 ? 'n' : ''} offen`
    : runner?.live ? `${STATE_LABEL[runner.state]} · ${shortModel(runner.model)}` : `${shortModel(project.model)} · ${fmtAgo(project.updatedAt)}`;
  return (
    <button className={`proj${active ? ' active' : ''}`} onClick={onClick} title={project.dir}>
      <span className={`tally ${runner?.live || st === 'error' ? st : ''}`} aria-label={STATE_LABEL[st]} />
      <span className="proj-name">{project.name}</span>
      <span className="proj-cost num">{runner?.stats?.costUsd ? fmtUsd(runner.stats.costUsd) : ''}</span>
      <span className={`proj-meta${st === 'waiting' ? ' waiting' : ''}`}>{meta}</span>
    </button>
  );
}

function SessionList({ project, runner }: { project: Project; runner?: RunnerStatus }) {
  const sessions = useStore((s) => s.sessions[project.id]);
  const view = useStore((s) => s.view);
  const openSession = useStore((s) => s.openSession);

  const open = async (sess: SessionInfo | null) => {
    const sid = sess?.sessionId ?? null;
    const isLive = runner?.live && runner.sessionId === sid;
    if (runner?.live && !isLive) {
      // Only look: the running session keeps running until the user switches explicitly
      await openSession(project.id, sid, false);
      return;
    }
    await act(() => conn.call('session.select', { projectId: project.id, sessionId: sid }));
    await openSession(project.id, sid, true);
  };

  const fresh = async () => {
    await act(() => conn.call('session.new', { projectId: project.id }));
    if (!runner?.live) await openSession(project.id, null, true);
  };

  return (
    <div style={{ padding: '2px 0 8px' }}>
      <button className="sess" onClick={fresh} title="Neue Session (bei laufendem Prozess: /clear)">
        <span className="sess-title" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', color: 'var(--text)' }}>
          <SquarePen size={13} /> Neue Session
        </span>
      </button>
      {(sessions ?? []).slice(0, 30).map((s) => {
        const live = !!runner?.live && runner.sessionId === s.sessionId;
        return (
          <div key={s.sessionId} className="sess-wrap">
            <button className={`sess${view?.sessionId === s.sessionId ? ' active' : ''}${live ? ' live' : ''}`} onClick={() => open(s)} title={s.title}>
              <span className="sess-title">{s.title}</span>
              <span className="sess-cost num">{s.costUsd ? fmtUsd(s.costUsd) : ''}</span>
              <span className="sess-meta">
                {fmtAgo(s.lastModified)}{s.turns ? ` · ${s.turns} Turns` : ''}{!s.hasLog ? ' · Terminal' : ''}{s.forkedFrom ? ' · Abzweig' : ''}
              </span>
            </button>
            <button
              className="btn ghost icon small sess-fork"
              title="Abzweigen: neue Session mit diesem Verlauf"
              onClick={() => act(() => conn.call('session.fork', { projectId: project.id, sessionId: s.sessionId }))}
            >
              <GitFork size={12} />
            </button>
          </div>
        );
      })}
      {sessions && !sessions.length && <div className="sess-meta" style={{ padding: '4px 24px' }}>Noch keine Sessions</div>}
    </div>
  );
}

function SideFoot() {
  const auth = useStore((s) => s.auth);
  const catalog = useStore((s) => s.catalog);
  const hello = useStore((s) => s.hello)!;
  const st = auth?.status;
  const plan = catalog?.account?.subscriptionType;
  const who = st?.email ?? catalog?.account?.email ?? (st?.authMethod && st.authMethod !== 'none' ? st.authMethod : null);
  return (
    <div className="side-foot">
      {st?.loggedIn ? (
        <button className="account btn ghost" style={{ height: 'auto', padding: '4px 6px', justifyContent: 'flex-start' }} onClick={() => useStore.setState({ loginOpen: true })}>
          <span className="tally ready" />
          <span className="account-name">{who ?? 'angemeldet'}{plan ? ` · ${plan}` : ''}</span>
        </button>
      ) : (
        <button className="btn primary" onClick={() => useStore.setState({ loginOpen: true })}>
          <LogIn size={14} /> Bei Claude anmelden
        </button>
      )}
      {hello.env.hints.map((h) => (
        <div className="hint" key={h.key}>
          {h.text}
          <code>{h.cmd}</code>
        </div>
      ))}
    </div>
  );
}
