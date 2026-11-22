import { Bell, Menu, PanelRightClose, PanelRightOpen, Power, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { MODE_LABEL, STATE_LABEL, fmtDuration } from '../lib/format';
import { useActive, useNow } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import type { PermissionMode } from '../lib/types';
import { conn } from '../lib/ws';
import { ProjectSettings } from './ProjectSettings';

export function Header({ showRight, onToggleRight, onToggleSide }: { showRight: boolean; onToggleRight: () => void; onToggleSide: () => void }) {
  const { project, runner } = useActive();
  const hello = useStore((s) => s.hello)!;
  const catalog = useStore((s) => s.catalog);
  const view = useStore((s) => s.view);
  const sessions = useStore((s) => (s.activeId ? s.sessions[s.activeId] : undefined));
  const [settings, setSettings] = useState(false);
  const running = runner?.state === 'running' || runner?.state === 'waiting';
  const now = useNow(1000, !!runner?.turn);
  const [notif, setNotif] = useState(() => ('Notification' in window ? Notification.permission : 'denied'));

  if (!project) {
    return (
      <header className="header">
        <button className="btn ghost icon" onClick={onToggleSide} aria-label="Projekte"><Menu size={16} /></button>
        <div className="header-title"><h1>Cockpit</h1></div>
      </header>
    );
  }

  const sessionTitle = sessions?.find((s) => s.sessionId === view?.sessionId)?.title ?? (view?.sessionId ? view.sessionId.slice(0, 8) : 'Neue Session');
  const model = runner?.live ? (project.model || 'default') : project.model || 'default';
  const modelInfo = catalog?.models.find((m) => m.value === model) ?? catalog?.models.find((m) => m.resolvedModel === runner?.model);
  const efforts = modelInfo?.supportsEffort ? modelInfo.supportedEffortLevels : [];
  const modes = hello.config.permissionModes.filter((m) => m !== 'bypassPermissions' || hello.config.allowBypass)
    .filter((m) => m !== 'auto' || modelInfo?.supportsAutoMode !== false);
  const st = runner?.pending?.length ? 'waiting' : runner?.state ?? 'idle';

  const pid = project.id;
  return (
    <header className="header">
      <button className="btn ghost icon only-mobile" onClick={onToggleSide} aria-label="Projekte"><Menu size={16} /></button>
      <div className="header-title">
        <h1 title={project.dir}>{project.name}</h1>
        <div className="header-sub">
          <span className="state-pill"><span className={`tally ${runner?.live || st === 'error' ? st : ''}`} />{runner?.live ? STATE_LABEL[st] : 'kein Prozess'}</span>
          {runner?.turn && <span className="tab-nums">{fmtDuration(now - runner.turn.startedAt)} · {runner.turn.calls} Calls</span>}
          {runner?.compacting && <span style={{ color: 'var(--blue)' }}>komprimiert Kontext …</span>}
          <span title={`${sessionTitle}${view?.sessionId ? ` · ${view.sessionId}` : ''}`} style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{sessionTitle}</span>
          {runner?.version && <span className="faint">Claude Code {runner.version}</span>}
        </div>
      </div>
      <div className="header-controls">
        <select className="select" aria-label="Modell" value={model}
          onChange={(e) => act(() => conn.call('setModel', { projectId: pid, model: e.target.value === 'default' ? '' : e.target.value }))}>
          {(catalog?.models.length ? catalog.models : [{ value: 'default', displayName: 'Standard' }]).map((m) => (
            <option key={m.value} value={m.value}>{m.displayName}</option>
          ))}
          {model !== 'default' && !catalog?.models.some((m) => m.value === model) && <option value={model}>{model}</option>}
        </select>
        <select className="select" aria-label="Berechtigungsmodus" value={runner?.live ? runner.mode : project.mode}
          onChange={(e) => act(() => conn.call('setMode', { projectId: pid, mode: e.target.value as PermissionMode }))}>
          {modes.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
        </select>
        {efforts.length > 0 && (
          <select className="select" aria-label="Effort" value={runner?.live ? runner.effort : project.effort}
            onChange={(e) => act(() => conn.call('setEffort', { projectId: pid, effort: e.target.value }))}>
            <option value="">Effort: Standard</option>
            {efforts.map((e) => <option key={e} value={e}>Effort: {e}</option>)}
          </select>
        )}
        {runner?.live && (
          <button className="btn ghost icon" title={running ? 'Prozess beenden (bricht den laufenden Schritt ab)' : 'Prozess beenden (Session bleibt fortsetzbar)'}
            onClick={() => act(() => conn.call('stop', { projectId: pid }))}>
            <Power size={15} />
          </button>
        )}
        {notif === 'default' && (
          <button className="btn ghost icon" title="Desktop-Benachrichtigung bei Freigaben" onClick={async () => setNotif(await Notification.requestPermission())}>
            <Bell size={15} />
          </button>
        )}
        <button className="btn ghost icon" title="Projekteinstellungen" onClick={() => setSettings(true)}><Settings2 size={15} /></button>
        <button className="btn ghost icon" title={showRight ? 'Seitenleiste ausblenden' : 'Seitenleiste einblenden'} onClick={onToggleRight}>
          {showRight ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
      </div>
      {settings && <ProjectSettings project={project} onClose={() => setSettings(false)} />}
    </header>
  );
}
