import { X } from 'lucide-react';
import { useCallback } from 'react';
import { useEscape } from '../lib/hooks';
import { useStore } from '../lib/store';
import { PlanLimits, SessionUsage } from './UsagePanel';

export function UsageDrawer() {
  const close = useCallback(() => useStore.setState({ usageOpen: false }), []);
  useEscape(close);
  return (
    <div className="drawer-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <aside className="drawer usage" aria-label="Verbrauch">
        <div className="drawer-head">
          <h2>Verbrauch</h2>
          <button className="btn ghost icon" onClick={close} aria-label="Schließen"><X size={15} /></button>
        </div>
        <div className="drawer-body"><PlanLimits /><SessionUsage /></div>
      </aside>
    </div>
  );
}
