import { t } from '../lib/i18n';
import { GitFork, Globe, Plus, Settings, SquarePen, X } from 'lucide-react';
import { useState } from 'react';

const HINTS_KEY = 'cockpit.hiddenHints';
import { STATE_LABEL, fmtAgo, fmtUsd } from '../lib/format';
import { useNow } from '../lib/hooks';
import { act, newProject, useStore } from '../lib/store';
import type { Project, RunnerStatus, SessionInfo } from '../lib/types';
import { conn } from '../lib/ws';
import { ProfileDialog } from './ProfileDialog';

function stateOf(r: RunnerStatus | undefined) {
  if (!r) return 'idle';
  if (r.pending?.length) return 'waiting';
  return r.state;
}

export function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const projects = useStore((s) => s.projects);
  const runners = useStore((s) => s.runners);
  const activeId = useStore((s) => s.activeId);
  const profileView = useStore((s) => s.profileView);
  const selectProject = useStore((s) => s.selectProject);
  useNow(30_000);

  return (
    <aside className="sidebar" aria-label="Navigation">
      <div className="brand">
        <span className="brand-mark" aria-hidden><i /><b /><b /><b /></span>
        <span className="brand-name">Cockpit</span>
      </div>
      <div className="side-scroll">
        <div className="side-head">
          <span>Projekte</span>
          <button className="btn ghost icon small" title="Neues Projekt" onClick={() => { newProject(); onNavigate(); }}><Plus size={14} /></button>
        </div>
        <div className="side-section">
          {projects.map((p) => {
            const active = p.id === activeId && !profileView;
            return (
              <div key={p.id}>
                <ProjectRow project={p} runner={runners[p.id]} active={active}
                  onClick={() => { if (p.id !== activeId) selectProject(p.id); else useStore.setState({ profileView: null }); onNavigate(); }} />
                {active && <SessionList project={p} runner={runners[p.id]} />}
              </div>
            );
          })}
        </div>
        <Profiles onNavigate={onNavigate} />
      </div>
      <SideFoot />
    </aside>
  );
}

function ProjectRow({ project, runner, active, onClick }: { project: Project; runner?: RunnerStatus; active: boolean; onClick: () => void }) {
  const st = stateOf(runner);
  const busy = st === 'running' || st === 'waiting' || st === 'starting' || st === 'error';
  const meta = runner?.pending?.length ? `${runner.pending.length} Freigabe${runner.pending.length > 1 ? 'n' : ''} offen`
    : busy ? STATE_LABEL[st] : fmtAgo(project.updatedAt);
  return (
    <button className={`proj${active ? ' active' : ''}${project.parentId ? ' proj--sub' : ''}`} onClick={onClick}
      title={[project.description, project.parentId ? `Sub-Session von „${project.parentId}“` : '', project.dir].filter(Boolean).join('\n')}>
      <span className={`tally ${busy ? st : 'none'}`} aria-label={busy ? STATE_LABEL[st] : undefined} />
      <span className="proj-name">{project.parentId && <span className="proj-sub" aria-label="Sub-Session">↳ </span>}{project.name}</span>
      <span className={`proj-meta${st === 'waiting' ? ' waiting' : ''}`}>{meta}</span>
    </button>
  );
}

function SessionList({ project, runner }: { project: Project; runner?: RunnerStatus }) {
  const sessions = useStore((s) => s.sessions[project.id]);
  const view = useStore((s) => s.view);
  const openSession = useStore((s) => s.openSession);
  const [all, setAll] = useState(false);

  const open = async (sess: SessionInfo) => {
    useStore.setState({ tab: 'session' });
    const sid = sess.sessionId;
    if (runner?.live && runner.sessionId !== sid) { await openSession(project.id, sid, false); return; }
    await act(() => conn.call('session.select', { projectId: project.id, sessionId: sid }));
    await openSession(project.id, sid, true);
  };
  const fresh = async () => {
    useStore.setState({ tab: 'session' });
    await act(() => conn.call('session.new', { projectId: project.id }));
    if (!runner?.live) await openSession(project.id, null, true);
  };
  const list = sessions ?? [];
  const shown = all ? list.slice(0, 40) : list.slice(0, 5);

  return (
    <div className="sess-list">
      {list.length > 0 && <button className="sess" onClick={fresh}><span className="sess-title sess-new"><SquarePen size={12} /> Neue Session</span></button>}
      {shown.map((s) => {
        const live = !!runner?.live && runner.sessionId === s.sessionId;
        return (
          <div key={s.sessionId} className="sess-wrap">
            <button className={`sess${view?.sessionId === s.sessionId ? ' active' : ''}${live ? ' live' : ''}`} onClick={() => open(s)} title={s.title}>
              <span className="sess-title">{s.title}</span>
              <span className="sess-meta">{fmtAgo(s.lastModified)}{s.costUsd ? ` · ${fmtUsd(s.costUsd)}` : ''}</span>
            </button>
            <button className="btn ghost icon small sess-fork" title="Abzweigen: neue Session mit diesem Verlauf"
              onClick={() => act(() => conn.call('session.fork', { projectId: project.id, sessionId: s.sessionId }))}>
              <GitFork size={12} />
            </button>
          </div>
        );
      })}
      {list.length > 5 && <button className="sess-more" onClick={() => setAll((v) => !v)}>{all ? 'weniger' : `alle ${list.length} Sessions`}</button>}
    </div>
  );
}

function Profiles({ onNavigate }: { onNavigate: () => void }) {
  const browsers = useStore((s) => s.browsers);
  const profileView = useStore((s) => s.profileView);
  const [edit, setEdit] = useState<string | null | 'new'>(null);
  return (
    <>
      <div className="side-head" style={{ marginTop: 10 }}>
        <span>Browser</span>
        <button className="btn ghost icon small" title="Neue Identität" onClick={() => setEdit('new')}><Plus size={14} /></button>
      </div>
      <div className="side-section">
        {(browsers?.profiles ?? []).map((p) => (
          <div key={p.id} className="sess-wrap">
            <button className={`proj${profileView === p.id ? ' active' : ''}`} onClick={() => { useStore.setState({ profileView: p.id }); onNavigate(); }}>
              <span className={`tally ${p.running ? 'ready' : 'none'}`} style={p.running ? { background: p.color, boxShadow: 'none' } : undefined} />
              <span className="proj-name">{p.name}</span>
              {(p.running ? p.title || p.url : p.temporary) && <span className="proj-meta">{p.running ? p.title || p.url : 'temporär'}</span>}
            </button>
            <button className="btn ghost icon small sess-fork" title="Profil bearbeiten" onClick={() => setEdit(p.id)}><Settings size={12} /></button>
          </div>
        ))}
        {!browsers?.profiles.length && <div className="sess-meta" style={{ padding: '4px 10px' }}><Globe size={12} /> keine Profile</div>}
      </div>
      {edit && <ProfileDialog id={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function SideFoot() {
  const auth = useStore((s) => s.auth);
  const github = useStore((s) => s.github);
  const catalog = useStore((s) => s.catalog);
  const hello = useStore((s) => s.hello)!;
  const claudeOk = auth?.status?.loggedIn || auth?.status?.envApiKey || auth?.status?.envOAuthToken;
  const plan = catalog?.account?.subscriptionType;
  const [hidden, setHidden] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(HINTS_KEY) ?? '[]'); } catch { return []; } });
  const hide = (key: string) => {
    const next = [...hidden, key];
    setHidden(next);
    try { localStorage.setItem(HINTS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  };
  return (
    <div className="side-foot">
      <button className="acct" onClick={() => useStore.setState({ loginOpen: true })} title="Konten verwalten">
        <span className={`tally ${claudeOk ? 'none' : 'error'}`} />
        <span className="acct-name">Claude{claudeOk ? (plan ? ` · ${plan}` : '') : ' – anmelden'}</span>
      </button>
      <button className="acct" onClick={() => useStore.setState({ loginOpen: true })} title="Konten verwalten">
        <span className="tally none" />
        <span className="acct-name">GitHub{github?.status?.loggedIn ? ` · ${github.status.login}` : github?.status?.installed === false ? '' : ' – verbinden'}</span>
      </button>
      {hello.env.hints.filter((h) => !hidden.includes(h.key)).map((h) => {
        const job = hello.installs?.[h.key];
        return (
          <div className="hint" key={h.key} title={h.why ? `${t(h.text)} – ${t(h.why)}` : h.text}>
            <button className="hint-x" onClick={() => hide(h.key)} aria-label="Hinweis ausblenden" title="Ausblenden"><X size={11} /></button>
            <span>{h.text}</span>
            {h.install ? (
              <button className="btn small hint-btn" disabled={job?.state === 'running'} title={job?.lines.slice(-3).join('\n') || h.cmd}
                onClick={() => act(() => conn.call('env.install', { key: h.key }))}>
                {job?.state === 'running' ? 'installiert …' : job?.state === 'failed' ? 'Erneut versuchen' : 'Installieren'}
              </button>
            ) : <code>{h.cmd}</code>}
          </div>
        );
      })}
      {hello.config.hasPassword && <a className="acct acct-link" href="/logout">Abmelden</a>}
    </div>
  );
}
