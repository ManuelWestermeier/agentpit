import { Menu, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { STATE_LABEL, fmtDuration, fmtPct, fmtUsd } from '../lib/format';
import { useActive, useNow } from '../lib/hooks';
import { useStore, type Tab } from '../lib/store';
import { ProjectSettings } from './ProjectSettings';

const TABS: [Tab, string][] = [['session', 'Session'], ['browser', 'Browser'], ['files', 'Dateien'], ['git', 'Git'], ['services', 'Dienste'], ['data', 'Daten']];

export function Header({ onToggleSide }: { onToggleSide: () => void }) {
  const { project, runner } = useActive();
  const view = useStore((s) => s.view);
  const tab = useStore((s) => s.tab);
  const profileView = useStore((s) => s.profileView);
  const profile = useStore((s) => s.browsers?.profiles.find((p) => p.id === s.profileView));
  const sessions = useStore((s) => (s.activeId ? s.sessions[s.activeId] : undefined));
  const [settings, setSettings] = useState(false);
  const now = useNow(1000, !!runner?.turn);

  if (profileView) {
    return (
      <header className="header">
        <button className="btn ghost icon only-mobile" onClick={onToggleSide} aria-label="Menü"><Menu size={16} /></button>
        <div className="header-title">
          <h1>{profile?.name ?? 'Browser'}</h1>
          <div className="header-sub">Browser-Identität · eigenes Profil mit Cookies, Logins und Speicher{profile?.proxy ? ' · Proxy' : ''}</div>
        </div>
        <UsagePill />
      </header>
    );
  }
  if (!project) {
    return (
      <header className="header">
        <button className="btn ghost icon only-mobile" onClick={onToggleSide} aria-label="Menü"><Menu size={16} /></button>
        <div className="header-title"><h1>Cockpit</h1></div>
      </header>
    );
  }

  const st = runner?.pending?.length ? 'waiting' : runner?.state ?? 'idle';
  const sessionTitle = sessions?.find((s) => s.sessionId === view?.sessionId)?.title ?? (view?.sessionId ? 'Session' : 'Neue Session');
  return (
    <header className="header has-tabs">
      <div className="header-row">
        <button className="btn ghost icon only-mobile" onClick={onToggleSide} aria-label="Menü"><Menu size={16} /></button>
        <div className="header-title">
          <h1 title={project.dir}>{project.name}</h1>
          <div className="header-sub">
            <span className="state-pill"><span className={`tally ${runner?.live || st === 'error' ? st : ''}`} />{runner?.live ? STATE_LABEL[st] : 'bereit'}</span>
            {runner?.turn && <span className="tab-nums">{fmtDuration(now - runner.turn.startedAt)} · {runner.turn.calls} Calls</span>}
            {runner?.compacting && <span style={{ color: 'var(--blue)' }}>komprimiert …</span>}
            <span className="ellipsis" title={view?.sessionId ?? ''}>{sessionTitle}</span>
          </div>
        </div>
        <UsagePill />
        <button className="btn ghost icon" title="Projekteinstellungen" onClick={() => setSettings(true)}><Settings2 size={16} /></button>
      </div>
      <nav className="tabs-main" role="tablist" aria-label="Bereiche">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => useStore.setState({ tab: k })}>
            {label}
            {k === 'session' && !!runner?.pending?.length && <span className="badge-dot" />}
          </button>
        ))}
      </nav>
      {settings && <ProjectSettings project={project} onClose={() => setSettings(false)} />}
    </header>
  );
}

function UsagePill() {
  const limits = useStore((s) => s.limits);
  const { runner } = useActive();
  const w5 = limits?.windows.five_hour;
  const cost = runner?.stats?.costUsd;
  const hot = w5 && w5.u >= 80;
  return (
    <button className={`usage-pill${hot ? ' hot' : ''}`} onClick={() => useStore.setState({ usageOpen: true })} title="Verbrauch, Limits und Prognose">
      {w5 ? <><b className="num">{fmtPct(w5.u)}</b><span>5 h</span></> : <span>Verbrauch</span>}
      {cost ? <><i /><b className="num">{fmtUsd(cost)}</b></> : null}
    </button>
  );
}
