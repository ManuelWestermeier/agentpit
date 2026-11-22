import { PanelRight } from 'lucide-react';
import { useState } from 'react';
import { ls, useActive } from '../lib/hooks';
import { useStore } from '../lib/store';
import { Banners } from './Banners';
import { BrowserView } from './BrowserView';
import { Composer } from './Composer';
import { Pending } from './Pending';
import { TimelineView } from './Timeline';

/** Conversation; with a linked browser identity optionally side by side with its live view. */
export function SessionView() {
  const { project } = useActive();
  const profiles = useStore((s) => s.browsers?.profiles ?? []);
  const linked = project?.browserProfile ? profiles.find((p) => p.id === project.browserProfile) : null;
  const [split, setSplit] = useState(() => ls.get('cockpit.split', '1') === '1');
  const toggle = () => setSplit((v) => { ls.set('cockpit.split', v ? '0' : '1'); return !v; });
  const showSplit = !!linked && split;

  return (
    <div className={`session${showSplit ? ' split' : ''}`}>
      <div className="session-main">
        <Banners />
        <TimelineView
          extra={linked ? (
            <button className={`chip${showSplit ? ' active' : ''}`} onClick={toggle} title="Verknüpften Browser daneben anzeigen">
              <PanelRight size={11} /> {linked.name}
            </button>
          ) : null}
        />
        <Pending />
        <Composer />
      </div>
      {showSplit && linked && <div className="session-side"><BrowserView profileId={linked.id} compact /></div>}
    </div>
  );
}
