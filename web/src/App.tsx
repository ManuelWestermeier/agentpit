import { useEffect, useState } from 'react';
import { Composer } from './components/Composer';
import { Header } from './components/Header';
import { LoginDialog } from './components/LoginDialog';
import { NewProjectDialog } from './components/NewProjectDialog';
import { Pending } from './components/Pending';
import { RightPanel } from './components/RightPanel';
import { Sidebar } from './components/Sidebar';
import { TimelineView } from './components/Timeline';
import { Toasts } from './components/Toasts';
import { Banners } from './components/Banners';
import { ls } from './lib/hooks';
import { useStore } from './lib/store';

export function App() {
  const init = useStore((s) => s.init);
  const hello = useStore((s) => s.hello);
  const connected = useStore((s) => s.connected);
  const activeId = useStore((s) => s.activeId);
  const loginOpen = useStore((s) => s.loginOpen);
  const newProjectOpen = useStore((s) => s.newProjectOpen);
  const pendingCount = useStore((s) => Object.values(s.runners).reduce((n, r) => n + (r.pending?.length ?? 0), 0));
  // On narrow screens the right panel overlays the timeline, so start closed there.
  const [showRight, setShowRight] = useState(() => window.innerWidth >= 980 && ls.get('cockpit.right', '1') === '1');
  const [showSide, setShowSide] = useState(false);

  useEffect(() => { init(); }, [init]);
  useEffect(() => { if (window.innerWidth >= 980) ls.set('cockpit.right', showRight ? '1' : '0'); }, [showRight]);
  useEffect(() => { document.title = pendingCount ? `(${pendingCount}) Freigabe – Cockpit` : 'Cockpit'; }, [pendingCount]);

  if (!hello) {
    return (
      <div className="empty" style={{ marginTop: '30vh' }}>
        <h2>Verbinde mit dem Cockpit-Server …</h2>
        <p>Läuft <code>npm start</code> noch?</p>
      </div>
    );
  }

  return (
    <div className={`app${showRight ? '' : ' no-right'}${showSide ? ' show-side' : ''}`}>
      <Sidebar onNavigate={() => setShowSide(false)} />
      <main className="main">
        <Header showRight={showRight} onToggleRight={() => setShowRight((v) => !v)} onToggleSide={() => setShowSide((v) => !v)} />
        {activeId ? (
          <>
            <Banners />
            <TimelineView />
            <Pending />
            <Composer />
          </>
        ) : (
          <div className="empty">
            <h2>Kein Projekt</h2>
            <p>Lege links ein Projekt an. Jedes Projekt ist ein Ordner unter <code>projects/</code>, in dem Claude Code arbeitet.</p>
            <button className="btn primary" onClick={() => useStore.setState({ newProjectOpen: true })}>Projekt anlegen</button>
          </div>
        )}
      </main>
      {showRight && <RightPanel />}
      <Toasts />
      {loginOpen && <LoginDialog />}
      {newProjectOpen && <NewProjectDialog />}
      {!connected && <div className="offline">Verbindung zum Server getrennt – verbinde neu …</div>}
    </div>
  );
}
