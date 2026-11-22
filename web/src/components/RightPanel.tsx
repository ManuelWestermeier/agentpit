import { FolderTree, Play, SquareTerminal } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useStore, type RightTab } from '../lib/store';
import { FilesPanel } from './FilesPanel';
import { PreviewPanel } from './PreviewPanel';
import { UsagePanel } from './UsagePanel';

const TerminalPanel = lazy(() => import('./TerminalPanel'));

export function RightPanel() {
  const tab = useStore((s) => s.rightTab);
  const terminals = useStore((s) => s.hello?.config.terminals);
  const preview = useStore((s) => s.preview);
  const activeId = useStore((s) => s.activeId);
  const set = (t: RightTab) => useStore.setState({ rightTab: t });
  return (
    <aside className="right" aria-label="Verbrauch und Dateien">
      <UsagePanel />
      <div className="tabs" role="tablist">
        <button className={`tab${tab === 'files' ? ' active' : ''}`} onClick={() => set('files')} role="tab" aria-selected={tab === 'files'}><FolderTree size={13} /> Dateien</button>
        <button className={`tab${tab === 'preview' ? ' active' : ''}`} onClick={() => set('preview')} role="tab" aria-selected={tab === 'preview'} disabled={!preview}><Play size={13} /> Vorschau</button>
        {terminals && <button className={`tab${tab === 'terminal' ? ' active' : ''}`} onClick={() => set('terminal')} role="tab" aria-selected={tab === 'terminal'}><SquareTerminal size={13} /> Terminal</button>}
      </div>
      <div className="tab-body">
        {tab === 'files' && <FilesPanel />}
        {tab === 'preview' && <PreviewPanel />}
        {tab === 'terminal' && terminals && <Suspense fallback={<div className="empty">Lade Terminal …</div>}><TerminalPanel key={activeId ?? ''} /></Suspense>}
      </div>
    </aside>
  );
}
