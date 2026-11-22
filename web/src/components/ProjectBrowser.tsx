import { Link2, Plus } from 'lucide-react';
import { useActive } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import type { BrowserProfile } from '../lib/types';
import { conn } from '../lib/ws';
import { BrowserView } from './BrowserView';

/** Project tab: which browser identity Claude uses here, plus its live view. */
export function ProjectBrowser() {
  const { project, runner } = useActive();
  const profiles = useStore((s) => s.browsers?.profiles ?? []);
  if (!project) return null;
  const linked = profiles.find((p) => p.id === project.browserProfile);

  const link = async (profileId: string) => {
    await act(() => conn.call('project.update', { projectId: project.id, patch: { browserProfile: profileId } }));
    if (runner?.live) useStore.getState().toast('info', 'Gilt ab dem nächsten Prozessstart – „Neu verbinden“ beendet den laufenden Prozess, der nächste Prompt setzt die Session fort.');
  };
  const createAndLink = async () => {
    const p = await act(() => conn.call<BrowserProfile>('browsers.create', { profile: { name: project.name } }));
    if (p) await link(p.id);
  };

  return (
    <div className="pbrowser">
      <div className="pbrowser-bar">
        <Link2 size={14} className="faint" />
        <span className="muted">Claude nutzt</span>
        <select className="select" value={project.browserProfile} onChange={(e) => link(e.target.value)} aria-label="Browser-Identität">
          <option value="">isolierten Browser ohne Logins</option>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="btn small" onClick={createAndLink}><Plus size={12} /> Neue Identität</button>
      </div>
      {linked ? <BrowserView profileId={linked.id} /> : (
        <div className="empty">
          <p className="faint">Mit einer Identität siehst du Claude live zu und meldest dich vorher selbst an.</p>
        </div>
      )}
    </div>
  );
}
