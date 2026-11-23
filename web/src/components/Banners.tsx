import { locale } from '../lib/i18n';
import { useActive } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import { conn } from '../lib/ws';

/** Context strips above the timeline: errors, login, read-only views, limit warnings. */
export function Banners() {
  const { project, runner } = useActive();
  const view = useStore((s) => s.view);
  const auth = useStore((s) => s.auth);
  const limits = useStore((s) => s.limits);
  const openSession = useStore((s) => s.openSession);
  if (!project) return null;

  const loggedIn = auth?.status?.loggedIn || auth?.status?.envApiKey || auth?.status?.envOAuthToken;
  const browsingOther = view && !view.follow && runner?.live && runner.sessionId !== view.sessionId;

  const takeOver = async () => {
    if (!view) return;
    await act(() => conn.call('session.select', { projectId: project.id, sessionId: view.sessionId }));
    await openSession(project.id, view.sessionId, true);
  };
  const backToLive = () => runner?.sessionId && openSession(project.id, runner.sessionId, true);

  return (
    <>
      {auth?.status && !loggedIn && (
        <div className="banner warn">
          <span style={{ flex: 1 }}>Claude Code ist nicht angemeldet. Sessions starten, aber jede Anfrage scheitert.</span>
          <button className="btn primary small" onClick={() => useStore.setState({ loginOpen: true })}>Anmelden</button>
        </div>
      )}
      {runner?.state === 'error' && runner.error && (
        <div className="banner error">
          <div style={{ flex: 1, minWidth: 0 }}>
            <b>Claude Code wurde unerwartet beendet.</b> Der nächste Prompt startet die Session neu.
            <pre>{runner.error}</pre>
          </div>
        </div>
      )}
      {browsingOther && (
        <div className="banner info">
          <span style={{ flex: 1 }}>Du siehst eine ältere Session. Im Hintergrund läuft eine andere weiter.</span>
          <button className="btn small" onClick={backToLive}>Zur laufenden</button>
          <button className="btn small" onClick={takeOver}>Diese fortsetzen</button>
        </div>
      )}
      {limits?.warning && (
        <div className={`banner ${limits.warning.status === 'rejected' ? 'error' : 'warn'}`}>
          {limits.warning.status === 'rejected'
            ? `Nutzungslimit erreicht${limits.warning.resetsAt ? ` – Reset ${new Date(limits.warning.resetsAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}` : ''}.`
            : 'Nutzungslimit bald erreicht.'}
        </div>
      )}
    </>
  );
}
