import { useState } from 'react';
import { useEscape } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import type { Project } from '../lib/types';
import { conn } from '../lib/ws';

export function ProjectSettings({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [browser, setBrowser] = useState(project.browser.enabled);
  const [headless, setHeadless] = useState(project.browser.headless);
  const [confirmDelete, setConfirmDelete] = useState('');
  const runner = useStore((s) => s.runners[project.id]);
  useEscape(onClose);

  const save = async () => {
    const r = await act(() => conn.call('project.update', { projectId: project.id, patch: { name, browser: { enabled: browser, headless } } }), 'Gespeichert');
    if (r) onClose();
  };
  const remove = async () => {
    const r = await act(() => conn.call<{ trashedTo: string }>('project.delete', { projectId: project.id }));
    if (r) {
      useStore.getState().toast('info', `In den Papierkorb verschoben: ${r.trashedTo}`);
      onClose();
    }
  };

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Projekteinstellungen">
        <h2>Projekt</h2>
        <p className="mono" style={{ userSelect: 'all', wordBreak: 'break-all' }}>{project.dir}</p>
        <label className="label" htmlFor="pname">Name</label>
        <input id="pname" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />

        <div style={{ marginTop: 14 }}>
          <span className="label">Browser-Steuerung (Playwright MCP)</span>
          <label className="check"><input type="checkbox" checked={browser} onChange={(e) => setBrowser(e.target.checked)} /> Browser-Tools für Claude aktivieren</label>
          <label className="check" style={{ marginTop: 6, opacity: browser ? 1 : 0.5 }}>
            <input type="checkbox" checked={headless} disabled={!browser} onChange={(e) => setHeadless(e.target.checked)} /> Unsichtbar (headless) – sonst öffnet sich ein Browserfenster
          </label>
          <p style={{ marginTop: 6 }}>Wirkt ab dem nächsten Prozessstart{runner?.live ? ' – der laufende Prozess behält seine Einstellung' : ''}. Das Browserprofil (Logins) liegt pro Projekt unter <code>data/browser/</code>.</p>
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Abbrechen</button>
          <button className="btn primary" onClick={save} disabled={!name.trim()}>Speichern</button>
        </div>

        <div style={{ marginTop: 22, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          <span className="label">Projekt entfernen</span>
          <p>Verschiebt Ordner, Logs und Statistik nach <code>trash/</code>. Nichts wird gelöscht. Zum Bestätigen den Projektnamen eintippen.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input" placeholder={project.name} value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} />
            <button className="btn danger" disabled={confirmDelete !== project.name} onClick={remove}>In den Papierkorb</button>
          </div>
        </div>
      </div>
    </div>
  );
}
