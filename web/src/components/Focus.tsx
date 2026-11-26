import { ArrowLeftRight, Columns2, Globe, MessageSquare } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useStore } from '../lib/store';

const KEY = 'cockpit.focus';
type Focus = { split: boolean; flip: boolean; width: number };
function saveFocus(f: Focus) { try { localStorage.setItem(KEY, JSON.stringify(f)); } catch { /* storage blocked */ } }
function setFocus(patch: Partial<Focus>) {
  const next = { ...useStore.getState().focus, ...patch };
  saveFocus(next);
  useStore.setState({ focus: next });
}

/** Main focus of a project: the chat, the browser, or both side by side. */
export function FocusSwitch() {
  const tab = useStore((s) => s.tab);
  const focus = useStore((s) => s.focus);
  const both = focus.split && (tab === 'session' || tab === 'browser');
  const pick = (t: 'session' | 'browser' | 'both') => {
    if (t === 'both') { setFocus({ split: true }); if (tab !== 'session' && tab !== 'browser') useStore.setState({ tab: 'session' }); return; }
    setFocus({ split: false });
    useStore.setState({ tab: t });
  };
  return (
    <span className="focus-switch" role="group" aria-label="Hauptfokus">
      <button aria-pressed={!both && tab === 'session'} onClick={() => pick('session')} title="Chat im Fokus"><MessageSquare size={12} /> Chat</button>
      <button aria-pressed={!both && tab === 'browser'} onClick={() => pick('browser')} title="Browser im Fokus"><Globe size={12} /> Browser</button>
      <button aria-pressed={both} onClick={() => pick('both')} title="Chat und Browser nebeneinander"><Columns2 size={12} /> Beides</button>
      {both && <button onClick={() => setFocus({ flip: !focus.flip })} title="Seiten tauschen" aria-label="Seiten tauschen"><ArrowLeftRight size={12} /></button>}
    </span>
  );
}

/** Chat and browser side by side; the divider can be dragged (width is remembered). */
export function SplitView({ chat, browser }: { chat: ReactNode; browser: ReactNode }) {
  const focus = useStore((s) => s.focus);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current || !box.current) return;
      const r = box.current.getBoundingClientRect();
      let pct = ((e.clientX - r.left) / r.width) * 100;
      if (focus.flip) pct = 100 - pct;
      box.current.style.setProperty('--split', `${Math.min(75, Math.max(25, pct))}%`);
    };
    const up = () => {
      if (!drag.current || !box.current) return;
      drag.current = false;
      document.body.style.userSelect = '';
      setFocus({ width: Math.round(parseFloat(box.current.style.getPropertyValue('--split')) || focus.width) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [focus.flip, focus.width]);
  const grip = <div className="split-grip" role="separator" aria-orientation="vertical" aria-label="Breite ändern" onPointerDown={() => { drag.current = true; document.body.style.userSelect = 'none'; }} />;
  return (
    <div ref={box} className={`split${focus.flip ? ' flip' : ''}`} style={{ ['--split' as string]: `${focus.width}%` }}>
      {focus.flip ? <><div className="pane">{browser}</div>{grip}<div className="pane secondary">{chat}</div></>
        : <><div className="pane">{chat}</div>{grip}<div className="pane secondary">{browser}</div></>}
    </div>
  );
}
