import { useCallback, useState } from 'react';
import { MODE_LABEL } from '../lib/format';
import { useEscape } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import type { PermissionMode, Project } from '../lib/types';
import { conn } from '../lib/ws';

export function NewProjectDialog() {
  const hello = useStore((s) => s.hello)!;
  const catalog = useStore((s) => s.catalog);
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<PermissionMode>('acceptEdits');
  const [browser, setBrowser] = useState(true);
  const headless = true;
  const profiles = useStore((s) => s.browsers?.profiles ?? []);
  const [profile, setProfile] = useState('');
  const [busy, setBusy] = useState(false);
  const close = useCallback(() => useStore.setState({ newProjectOpen: false }), []);
  useEscape(close);
  const modes = hello.config.permissionModes.filter((m) => m !== 'bypassPermissions' || hello.config.allowBypass);

  const create = async () => {
    setBusy(true);
    const p = await act(() => conn.call<Project>('project.create', { project: { name, model, mode, browserProfile: browser ? profile : '', browser: { enabled: browser, headless } } }));
    setBusy(false);
    if (!p) return;
    close();
    const st = useStore.getState();
    if (!st.projects.some((x) => x.id === p.id)) useStore.setState({ projects: [p, ...st.projects] });
    st.selectProject(p.id);
  };

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-label="Neues Projekt">
        <h2>Neues Projekt</h2>
        <p>Legt <code>projects/&lt;id&gt;/</code> als Git-Repository an – mit CLAUDE.md, .gitignore, Video- und Browser-Skill, <code>input/</code> und <code>output/</code>.</p>
        <label className="label" htmlFor="np-name">Name</label>
        <input id="np-name" className="input" autoFocus value={name} maxLength={80} placeholder="z. B. Promo-Video küin"
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) create(); }} />
        <div className="modal-row" style={{ marginTop: 12 }}>
          <div>
            <label className="label" htmlFor="np-model">Modell</label>
            <select id="np-model" className="select" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Standard</option>
              {(catalog?.models ?? []).filter((m) => m.value !== 'default').map((m) => <option key={m.value} value={m.value}>{m.displayName}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="np-mode">Freigaben</label>
            <select id="np-mode" className="select" value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              {modes.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
            </select>
          </div>
        </div>
        <label className="check"><input type="checkbox" checked={browser} onChange={(e) => setBrowser(e.target.checked)} /> Browser für Claude</label>
        {browser && (
          <select className="select" style={{ marginTop: 6 }} value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="Browser-Identität">
            <option value="">Eigenes Projektprofil (unsichtbar)</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>Identität: {p.name}</option>)}
          </select>
        )}
        <div className="modal-actions">
          <button className="btn ghost" onClick={close}>Abbrechen</button>
          <button className="btn primary" disabled={!name.trim() || busy} onClick={create}>Projekt anlegen</button>
        </div>
      </div>
    </div>
  );
}
