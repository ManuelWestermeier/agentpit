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
  const [compactPct, setCompactPct] = useState(project.autoCompactPct != null ? String(project.autoCompactPct) : '');
  const [confirmDelete, setConfirmDelete] = useState('');
  const grants = project.grants ?? [];
  const revoke = (g: string) => act(() => conn.call('project.update', { projectId: project.id, patch: { grants: grants.filter((x) => x !== g) } }));
  const runner = useStore((s) => s.runners[project.id]);
  const profiles = useStore((s) => s.browsers?.profiles ?? []);
  useEscape(onClose);

  const save = async () => {
    const patch = { name, autoCommit, browserProfile: profile, browser: { enabled: browser, headless }, ...(compactPct !== '' ? { autoCompactPct: Number(compactPct) } : {}) };
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
          <option value="">isolierter Browser ohne Logins</option>
          {profiles.map((p) => <option key={p.id} value={p.id}>Identität: {p.name}{p.temporary ? ' (temporär)' : ''}</option>)}
        </select>
        {browser && !profile && (
          <label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} /> Unsichtbar (headless)</label>
        )}
        <p className="small-text muted" style={{ marginTop: 6 }}>
          Mit einer Identität arbeitet Claude in demselben Browser, den du live siehst – samt deinen Logins. Ein Wechsel wirkt sofort{runner?.live ? ', auch in der laufenden Session' : ''}.
        </p>

        <span className="label" style={{ marginTop: 16 }}>Versionskontrolle</span>
        <label className="check"><input type="checkbox" checked={autoCommit} onChange={(e) => setAutoCommit(e.target.checked)} /> Nach jeder abgeschlossenen Aufgabe automatisch committen</label>

        <span className="label" style={{ marginTop: 16 }}>Kontext</span>
        <label className="check" style={{ gap: 6 }}>
          Zusammenfassen ab
          <input className="input" style={{ width: 70, height: 26 }} type="number" min={0} max={100} value={compactPct} placeholder={String(useStore.getState().hello?.config.autoCompactPct ?? 75)} onChange={(e) => setCompactPct(e.target.value)} />
          % Füllung (0 = nur Claude Codes eigene)
        </label>
        <p className="small-text muted">Der vollständige Verlauf bleibt in <code>context/</code> erhalten.</p>

        {grants.length > 0 && (
          <>
            <span className="label" style={{ marginTop: 16 }}>Dauerhafte Freigaben</span>
            <ul className="grants">
              {grants.map((g) => (
                <li key={g}><code>{g}</code><button className="btn ghost small" onClick={() => revoke(g)}>Entziehen</button></li>
              ))}
            </ul>
          </>
        )}

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
