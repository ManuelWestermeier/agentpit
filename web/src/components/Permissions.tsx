import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { act, useStore } from '../lib/store';
import { conn } from '../lib/ws';

/** Unlock "Alles erlauben" (ALLOW_BYPASS_PERMISSIONS, kept in .env) – with the warning in plain words. */
export function UnlockBypass({ onDone }: { onDone?: () => void }) {
  const [sure, setSure] = useState(false);
  return (
    <div className="bypass-lock">
      <p><b>„Alles erlauben“ ist gesperrt.</b> Claude dürfte damit jeden Befehl ausführen und jede Datei ändern, ohne zu fragen – auf diesem Rechner, mit deinen Rechten.</p>
      <p className="muted">Freischalten setzt <code>ALLOW_BYPASS_PERMISSIONS=true</code> in der <code>.env</code> und gilt sofort. Zugriffe auf andere Projekte fragen weiter nach.</p>
      <label className="check"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> Ich verstehe das Risiko</label>
      <div className="perm-actions">
        <button className="btn primary" disabled={!sure} onClick={() => act(() => conn.call('config.allowBypass', { on: true })).then(() => onDone?.())}>Freischalten</button>
      </div>
    </div>
  );
}

/** Account dialog: current state of the lock, switch it on or off. */
export function BypassSection() {
  const allow = useStore((s) => s.hello?.config.allowBypass);
  return (
    <section>
      <h3>{allow ? <ShieldOff size={14} /> : <ShieldCheck size={14} />} Freigaben</h3>
      {allow ? (
        <>
          <p className="muted">„Alles erlauben“ ist freigeschaltet: Sessions in diesem Modus fragen nicht mehr nach (außer bei Zugriffen auf andere Projekte).</p>
          <button className="btn" onClick={() => act(() => conn.call('config.allowBypass', { on: false }))}>Wieder sperren</button>
        </>
      ) : <UnlockBypass />}
    </section>
  );
}

/** Set the mode; "Alles erlauben" while locked opens the explanation instead of failing silently. */
export function useModeSwitch(projectId: string) {
  const allow = useStore((s) => s.hello?.config.allowBypass);
  const [locked, setLocked] = useState(false);
  const set = (mode: string) => {
    if (mode === 'bypassPermissions' && !allow) { setLocked(true); return; }
    setLocked(false);
    act(() => conn.call('setMode', { projectId, mode }));
  };
  const panel = locked ? (
    <div className="bypass-pop" role="dialog" aria-label="Alles erlauben">
      <UnlockBypass onDone={() => { setLocked(false); act(() => conn.call('setMode', { projectId, mode: 'bypassPermissions' })); }} />
      <button className="btn ghost small" onClick={() => setLocked(false)}>Abbrechen</button>
    </div>
  ) : null;
  return { set, panel };
}

/** Chat notice: actions refused without asking (mode "Nicht fragen" or deny rules), with a way out. */
export function DeniedNotice({ projectId, mode, tools }: { projectId: string; mode: string; tools: { name: string; detail?: string }[] }) {
  const sw = useModeSwitch(projectId);
  const names = [...new Set(tools.map((t) => t.name))].join(', ');
  return (
    <div className="note warn denied">
      <div>
        <b>Ohne Nachfrage abgelehnt: {names}</b>
        <div className="muted">{mode === 'dontAsk' ? 'Der Modus „Nicht fragen“ lehnt alles ab, was nicht vorab erlaubt ist.' : 'Eine Regel in den Einstellungen hat das blockiert.'}</div>
        {tools.some((t) => t.detail) && <pre>{tools.filter((t) => t.detail).map((t) => `${t.name}: ${t.detail}`).join('\n')}</pre>}
        <div className="perm-actions">
          <button className="btn small" onClick={() => sw.set('default')}>Auf „Nachfragen“ wechseln</button>
          <button className="btn small" onClick={() => sw.set('bypassPermissions')}>Alles erlauben</button>
        </div>
        {sw.panel}
      </div>
    </div>
  );
}
