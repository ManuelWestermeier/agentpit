import { useState } from 'react';
import { useEscape } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import type { Project } from '../lib/types';
import { conn } from '../lib/ws';

export function ProjectSettings({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [browser, setBrowser] = useState(project.browser.enabled);
  const [headless, setHeadless] = useState(project.browser.headless);
  const [profile, setProfile] = useState(project.browserProfile);
  const [autoCommit, setAutoCommit] = useState(project.autoCommit);
  const [confirmDelete, setConfirmDelete] = useState('');
  const runner = useStore((s) => s.runners[project.id]);
  const profiles = useStore((s) => s.browsers?.profiles ?? []);
  useEscape(onClose);

  const save = async () => {
    const patch = { name, autoCommit, browserProfile: profile, browser: { enabled: browser, headless } };
    if (await act(() => conn.call('project.update', { projectId: project.id, patch }), 'Gespeichert')) onClose();
  };
  const remove = async () => {
    const r = await act(() => conn.call<{ trashedTo: string }>('project.delete', { projectId: project.id }));
    if (r) { useStore.getState().toast('info', `In den Papierkorb verschoben: ${r.trashedTo}`); onClose(); }
  };

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Projekteinstellungen">
        <h2>Projekt</h2>
        <p className="mono small-text" style={{ userSelect: 'all', wordBreak: 'break-all' }}>{project.dir}</p>
        <label className="label" htmlFor="pname">Name</label>
        <input id="pname" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />

        <span className="label" style={{ marginTop: 16 }}>Browser für Claude</span>
        <label className="check"><input type="checkbox" checked={browser} onChange={(e) => setBrowser(e.target.checked)} /> Browser-Tools aktivieren (Playwright MCP)</label>
        <select className="select" style={{ marginTop: 8 }} disabled={!browser} value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="Browser-Identität">
          <option value="">Eigenes Projektprofil (unsichtbar, nicht live steuerbar)</option>
          {profiles.map((p) => <option key={p.id} value={p.id}>Identität: {p.name}{p.temporary ? ' (temporär)' : ''}</option>)}
        </select>
        {browser && !profile && (
          <label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} /> Unsichtbar (headless)</label>
        )}
        <p className="small-text muted" style={{ marginTop: 6 }}>
          Mit einer Identität arbeitet Claude in demselben Browser, den du live siehst und steuerst – samt deinen Logins. Wirkt ab dem nächsten Prozessstart{runner?.live ? ' (der laufende Prozess behält seine Einstellung)' : ''}.
        </p>

        <span className="label" style={{ marginTop: 16 }}>Versionskontrolle</span>
        <label className="check"><input type="checkbox" checked={autoCommit} onChange={(e) => setAutoCommit(e.target.checked)} /> Nach jeder abgeschlossenen Aufgabe automatisch committen</label>

        <div className="modal-actions">
          <button className="btn ghost" onClick={() => act(() => conn.call('project.update', { projectId: project.id, patch: { rotateHookToken: true } }), 'Neuer Hook-Token – laufende Dienste neu starten')} title="Macht alte Hook-Token ungültig">Hook-Token erneuern</button>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Abbrechen</button>
          <button className="btn primary" onClick={save} disabled={!name.trim()}>Speichern</button>
        </div>

        <div className="danger-zone">
          <span className="label">Projekt entfernen</span>
          <p className="small-text">Verschiebt Ordner, Logs und Statistik nach <code>trash/</code>. Zum Bestätigen den Projektnamen eintippen.</p>
          <div className="row-inline">
            <input className="input" placeholder={project.name} value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} />
            <button className="btn danger" disabled={confirmDelete !== project.name} onClick={remove}>In den Papierkorb</button>
          </div>
        </div>
      </div>
    </div>
  );
}
