import { LogOut } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { BrowserView } from './BrowserView';

/**
 * Page of a browser user (/u/<name>): only the identities the admin assigned – no projects,
 * no sessions. The browser fills the window; fullscreen makes it feel like a local browser.
 */
export function BrowserOnly() {
  const hello = useStore((s) => s.hello);
  const profiles = useStore((s) => s.browsers?.profiles ?? []);
  const connected = useStore((s) => s.connected);
  const [pick, setPick] = useState<string | null>(null);
  const id = profiles.find((p) => p.id === pick)?.id ?? profiles[0]?.id ?? null;
  useEffect(() => { document.title = profiles.find((p) => p.id === id)?.name ?? 'Browser'; }, [id, profiles]);

  const bar = (
    <span className="bo-user">
      {profiles.length > 1 && (
        <select className="mini-select" value={id ?? ''} onChange={(e) => setPick(e.target.value)} aria-label="Browser wählen">
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      <a className="btn ghost icon small" href="/logout" title={`Abmelden (${hello?.user?.name ?? ''})`}><LogOut size={13} /></a>
    </span>
  );
  return (
    <div className="bo">
      {id ? <BrowserView key={id} profileId={id} extra={bar} />
        : <div className="empty"><h2>Kein Browser freigegeben</h2><p>Der Admin muss dir eine Browser-Identität zuweisen.</p><a className="btn" href="/logout">Abmelden</a></div>}
      {!connected && <div className="offline">Verbindung getrennt – verbinde neu …</div>}
    </div>
  );
}
