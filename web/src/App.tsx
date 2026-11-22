import { lazy, Suspense, useEffect, useState } from 'react';
import { SetupPassword } from './components/Access';
import { AccountsDialog } from './components/AccountsDialog';
import { BrowserView } from './components/BrowserView';
import { DataView } from './components/DataView';
import { FilesView } from './components/FilesView';
import { GitView } from './components/GitView';
import { Header } from './components/Header';
import { ProjectBrowser } from './components/ProjectBrowser';
import { SessionView } from './components/SessionView';
import { Sidebar } from './components/Sidebar';
import { Toasts } from './components/Toasts';
import { UsageDrawer } from './components/UsageDrawer';
import { newProject, useStore } from './lib/store';

const ServicesView = lazy(() => import('./components/ServicesView'));

export function App() {
  const init = useStore((s) => s.init);
  const hello = useStore((s) => s.hello);
  const connected = useStore((s) => s.connected);
  const activeId = useStore((s) => s.activeId);
  const tab = useStore((s) => s.tab);
  const profileView = useStore((s) => s.profileView);
  const loginOpen = useStore((s) => s.loginOpen);
  const usageOpen = useStore((s) => s.usageOpen);
  const pendingCount = useStore((s) => Object.values(s.runners).reduce((n, r) => n + (r.pending?.length ?? 0), 0));
  const [showSide, setShowSide] = useState(false);

  useEffect(() => { init(); }, [init]);
  useEffect(() => { document.title = pendingCount ? `(${pendingCount}) Freigabe – Cockpit` : 'Cockpit'; }, [pendingCount]);

  if (!hello) {
    return (
      <div className="empty" style={{ marginTop: '30vh' }}>
        <h2>Verbinde mit dem Cockpit …</h2>
        <p>Läuft der Server noch?</p>
      </div>
    );
  }

  let body;
  if (profileView) body = <BrowserView profileId={profileView} />;
  else if (!activeId) {
    body = (
      <div className="empty">
        <button className="btn primary" onClick={() => newProject()}>Neues Projekt</button>
      </div>
    );
  } else if (tab === 'session') body = <SessionView />;
  else if (tab === 'browser') body = <ProjectBrowser />;
  else if (tab === 'files') body = <FilesView />;
  else if (tab === 'git') body = <GitView />;
  else if (tab === 'services') body = <Suspense fallback={<div className="empty">Lade …</div>}><ServicesView /></Suspense>;
  else body = <DataView />;

  return (
    <div className={`app${showSide ? ' show-side' : ''}`}>
      <Sidebar onNavigate={() => setShowSide(false)} />
      {showSide && <div className="scrim" onClick={() => setShowSide(false)} />}
      <main className="main">
        <Header onToggleSide={() => setShowSide((v) => !v)} />
        <div className="body">{body}</div>
      </main>
      {usageOpen && <UsageDrawer />}
      <Toasts />
      {loginOpen && <AccountsDialog />}
      {!hello.config.hasPassword && <SetupPassword />}
      {!connected && <div className="offline">Verbindung getrennt – verbinde neu …</div>}
    </div>
  );
}
