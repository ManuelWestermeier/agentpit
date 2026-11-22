import { ArrowLeft, ArrowRight, Download, Keyboard, Loader2, Maximize, Plus, Power, RotateCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { act, useStore } from '../lib/store';
import { conn } from '../lib/ws';

interface Tab { i: number; url: string; title: string; active: boolean }
interface Dialog { type: string; message: string; defaultValue: string }

const BUTTON: Record<number, string> = { 0: 'left', 1: 'middle', 2: 'right' };

/** Live view + remote control of a browser identity (CDP screencast and input). */
export function BrowserView({ profileId, compact = false }: { profileId: string; compact?: boolean }) {
  const profile = useStore((s) => s.browsers?.profiles.find((p) => p.id === profileId));
  const status = useStore((s) => s.browsers?.status);
  const connected = useStore((s) => s.connected);
  const img = useRef<HTMLImageElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const kbd = useRef<HTMLInputElement>(null);
  const frameSize = useRef({ w: 1366, h: 800 });
  const [hasFrame, setHasFrame] = useState(false);
  const [state, setState] = useState<{ url: string; title: string; tabs: Tab[] }>({ url: '', title: '', tabs: [] });
  const [url, setUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogText, setDialogText] = useState('');
  const moveQueued = useRef<null | { x: number; y: number; buttons: number }>(null);
  const touch = useRef<{ x: number; y: number; lastY: number; lastX: number; drag: boolean } | null>(null);

  const startedFor = useRef<string | null>(null);
  const [off, setOff] = useState(false);
  const [startNonce, setStartNonce] = useState(0);
  const usedNonce = useRef(0);

  // Subscribe while mounted, after reconnects and when the browser comes back (e.g. started by Claude).
  // Auto-start only on first open – a browser the user switched off stays off.
  useEffect(() => {
    if (!connected) return;
    const first = startedFor.current !== profileId;
    startedFor.current = profileId;
    const wantStart = startNonce !== usedNonce.current;
    usedNonce.current = startNonce;
    if (!profile?.running && !first && !wantStart) { setOff(true); return; }
    setOff(false);
    setError(null);
    setHasFrame(false);
    conn.call('browsers.view', { id: profileId, on: true }, 60_000).catch((e) => setError(e.message));
    const off = conn.onMessage((m) => {
      if (m.profileId !== profileId) return;
      if (m.t === 'bframe') {
        frameSize.current = { w: m.w, h: m.h };
        if (img.current) img.current.src = `data:image/jpeg;base64,${m.data}`;
        setHasFrame(true);
      } else if (m.t === 'bstate') {
        if (m.stopped) { setHasFrame(false); setState({ url: '', title: '', tabs: [] }); return; }
        setState({ url: m.url, title: m.title, tabs: m.tabs ?? [] });
      } else if (m.t === 'bdialog') {
        setDialog({ type: m.type, message: m.message, defaultValue: m.defaultValue });
        setDialogText(m.defaultValue ?? '');
      }
    });
    return () => { off(); conn.send('browsers.view', { id: profileId, on: false }); };
  }, [profileId, connected, profile?.running, startNonce]);

  useEffect(() => { if (!editing) setUrl(state.url === 'about:blank' ? '' : state.url); }, [state.url, editing]);

  const send = useCallback((ev: Record<string, unknown>) => conn.send('browsers.input', { id: profileId, ev }), [profileId]);
  const point = (clientX: number, clientY: number) => {
    const r = img.current!.getBoundingClientRect();
    return { x: Math.round(((clientX - r.left) / r.width) * frameSize.current.w), y: Math.round(((clientY - r.top) / r.height) * frameSize.current.h) };
  };
  const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => ({ alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey });

  const onPointerDown = (e: PointerEvent<HTMLImageElement>) => {
    stage.current?.focus({ preventScroll: true });
    e.preventDefault();
    const p = point(e.clientX, e.clientY);
    if (e.pointerType === 'touch') { touch.current = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, drag: false }; return; }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    send({ kind: 'mouse', type: 'down', ...p, button: BUTTON[e.button] ?? 'left', buttons: e.buttons, clickCount: e.detail || 1, ...mods(e) });
  };
  const onPointerMove = (e: PointerEvent<HTMLImageElement>) => {
    const t = touch.current;
    if (e.pointerType === 'touch') {
      if (!t) return;
      if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > 8) t.drag = true;
      if (t.drag) {
        const p = point(e.clientX, e.clientY);
        const scale = frameSize.current.h / img.current!.getBoundingClientRect().height;
        send({ kind: 'wheel', ...p, dx: (t.lastX - e.clientX) * scale, dy: (t.lastY - e.clientY) * scale });
        t.lastX = e.clientX; t.lastY = e.clientY;
      }
      return;
    }
    const queued = moveQueued.current;
    moveQueued.current = { ...point(e.clientX, e.clientY), buttons: e.buttons };
    if (!queued) requestAnimationFrame(() => {
      const m = moveQueued.current;
      moveQueued.current = null;
      if (m) send({ kind: 'mouse', type: 'move', ...m, button: m.buttons & 1 ? 'left' : 'none' });
    });
  };
  const onPointerUp = (e: PointerEvent<HTMLImageElement>) => {
    const p = point(e.clientX, e.clientY);
    if (e.pointerType === 'touch') {
      const t = touch.current;
      touch.current = null;
      if (t && !t.drag) {
        send({ kind: 'mouse', type: 'down', ...p, button: 'left', buttons: 1, clickCount: 1 });
        send({ kind: 'mouse', type: 'up', ...p, button: 'left', clickCount: 1 });
      }
      return;
    }
    send({ kind: 'mouse', type: 'up', ...p, button: BUTTON[e.button] ?? 'left', clickCount: e.detail || 1, ...mods(e) });
  };
  const onWheel = (e: WheelEvent<HTMLImageElement>) => {
    const p = point(e.clientX, e.clientY);
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    send({ kind: 'wheel', ...p, dx: e.deltaX * unit, dy: e.deltaY * unit, ...mods(e) });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>, type: 'down' | 'up') => {
    if (e.target !== stage.current) return; // typing in toolbar inputs
    const isPaste = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v';
    if (isPaste) return; // handled by the paste event with the local clipboard
    e.preventDefault();
    const text = e.key.length === 1 ? e.key : e.key === 'Enter' ? '\r' : undefined;
    send({ kind: 'key', type, key: e.key, code: e.code, keyCode: e.keyCode, location: e.location, text, ...mods(e) });
  };

  const nav = (action: string, target?: string) => act(() => conn.call('browsers.nav', { id: profileId, action, url: target }));
  const tab = (op: string, index?: number) => act(() => conn.call('browsers.tab', { id: profileId, op, index }));
  const fit = () => {
    const r = stage.current!.getBoundingClientRect();
    act(() => conn.call('browsers.resize', { id: profileId, width: Math.floor(r.width), height: Math.floor(r.height) }));
  };
  const answer = (accept: boolean) => { conn.send('browsers.dialog', { id: profileId, accept, text: dialogText }); setDialog(null); };

  if (!profile) return <div className="empty">Profil nicht gefunden.</div>;

  const needsInstall = error && /installier|nicht gefunden/i.test(error);
  return (
    <div className={`bview${compact ? ' bview--compact' : ''}`}>
      <div className="btoolbar">
        <button className="btn ghost icon small" title="Zurück" onClick={() => nav('back')}><ArrowLeft size={14} /></button>
        {!compact && <button className="btn ghost icon small" title="Vor" onClick={() => nav('forward')}><ArrowRight size={14} /></button>}
        <button className="btn ghost icon small" title="Neu laden" onClick={() => nav('reload')}><RotateCw size={13} /></button>
        <form className="burl" onSubmit={(e) => { e.preventDefault(); setEditing(false); nav('go', url); stage.current?.focus(); }}>
          <span className="bdot" style={{ background: profile.color }} title={profile.name} />
          <input value={url} placeholder="Adresse oder Suche" onFocus={(e) => { setEditing(true); e.target.select(); }} onBlur={() => setEditing(false)}
            onChange={(e) => setUrl(e.target.value)} spellCheck={false} aria-label="Adresse" />
        </form>
        {!compact && <button className="btn ghost icon small" title="Ansicht an Fenster anpassen" onClick={fit}><Maximize size={13} /></button>}
        <button className="btn ghost icon small only-touch" title="Tastatur" onClick={() => kbd.current?.focus()}><Keyboard size={14} /></button>
        {!compact && profile.running && <button className="btn ghost icon small" title="Browser beenden" onClick={() => act(() => conn.call('browsers.stop', { id: profileId }))}><Power size={13} /></button>}
      </div>
      {!compact && state.tabs.length > 0 && (
        <div className="btabs">
          {state.tabs.map((t) => (
            <span key={t.i} className={`btab${t.active ? ' active' : ''}`}>
              <button onClick={() => tab('select', t.i)} title={t.url}>{t.title || t.url.replace(/^https?:\/\//, '') || 'Neuer Tab'}</button>
              <button className="btab-x" onClick={() => tab('close', t.i)} aria-label="Tab schließen"><X size={11} /></button>
            </span>
          ))}
          <button className="btn ghost icon small" title="Neuer Tab" onClick={() => tab('new')}><Plus size={13} /></button>
        </div>
      )}
      <div className="bstage" ref={stage} tabIndex={0} onKeyDown={(e) => onKey(e, 'down')} onKeyUp={(e) => onKey(e, 'up')}
        onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t) { e.preventDefault(); send({ kind: 'text', text: t }); } }}
        onContextMenu={(e) => e.preventDefault()} aria-label="Ferngesteuerter Browser – klicken, dann tippen">
        <img ref={img} alt="" draggable={false} style={{ visibility: hasFrame ? 'visible' : 'hidden' }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onWheel={onWheel} />
        {off && !error && (
          <div className="boverlay col">
            <span className="muted">Browser ist aus.</span>
            <button className="btn primary" onClick={() => setStartNonce((n) => n + 1)}><Power size={13} /> Starten</button>
          </div>
        )}
        {!off && !hasFrame && !error && <div className="boverlay"><Loader2 size={18} className="spin" /> {profile.running ? 'warte auf Bild …' : 'starte Browser …'}</div>}
        {error && (
          <div className="boverlay col">
            <div className="err" style={{ whiteSpace: 'pre-wrap', maxWidth: 520, textAlign: 'center' }}>{error}</div>
            {needsInstall && !status?.bundled && <InstallBox />}
            <button className="btn" onClick={() => { setError(null); conn.call('browsers.view', { id: profileId, on: true }, 60_000).catch((e) => setError(e.message)); }}>Erneut starten</button>
          </div>
        )}
        {dialog && (
          <div className="boverlay col">
            <div className="bdialog">
              <b>{dialog.type === 'beforeunload' ? 'Seite verlassen?' : 'Meldung der Seite'}</b>
              <p>{dialog.message}</p>
              {dialog.type === 'prompt' && <input className="input" value={dialogText} onChange={(e) => setDialogText(e.target.value)} />}
              <div className="perm-actions"><button className="btn primary" onClick={() => answer(true)}>OK</button>{dialog.type !== 'alert' && <button className="btn" onClick={() => answer(false)}>Abbrechen</button>}</div>
            </div>
          </div>
        )}
        <input ref={kbd} className="bkbd" aria-label="Texteingabe für den Browser" autoCapitalize="off" autoCorrect="off"
          onKeyDown={(e) => {
            if (['Enter', 'Backspace', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape'].includes(e.key)) {
              e.preventDefault();
              send({ kind: 'key', type: 'down', key: e.key, code: e.code, keyCode: e.keyCode, text: e.key === 'Enter' ? '\r' : undefined });
              send({ kind: 'key', type: 'up', key: e.key, code: e.code, keyCode: e.keyCode });
            }
          }}
          onInput={(e) => { const v = (e.target as HTMLInputElement).value; if (v) send({ kind: 'text', text: v }); (e.target as HTMLInputElement).value = ''; }} />
      </div>
    </div>
  );
}

export function InstallBox() {
  const status = useStore((s) => s.browsers?.status);
  const inst = status?.install;
  return (
    <div className="install-box">
      <p>Chromium wird lokal nach <code>{status?.path}</code> installiert (ca. 150 MB, inkl. ffmpeg für Browser-Videos).</p>
      <button className="btn primary" disabled={inst?.state === 'running'} onClick={() => act(() => conn.call('browsers.install'))}>
        {inst?.state === 'running' ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Browser installieren
      </button>
      {!!inst?.lines.length && <div className="login-out">{inst.lines.slice(-8).join('\n')}</div>}
    </div>
  );
}
