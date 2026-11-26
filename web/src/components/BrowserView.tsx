import { ArrowLeft, ArrowRight, Download, Expand, Gauge, Keyboard, Loader2, Maximize, Mic, MicOff, Minimize, Video, VideoOff, Plus, Power, RotateCw, Upload, Volume2, VolumeX, X } from 'lucide-react';
import { useRemoteAudio } from '../lib/remoteAudio';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { act, useStore } from '../lib/store';
import type { StreamSettings, StreamStats } from '../lib/types';
import { conn } from '../lib/ws';
import { DEFAULT_STREAM, StreamControls, StreamStatsView } from './StreamSettings';

interface Tab { i: number; url: string; title: string; active: boolean }
interface Dialog { type: string; message: string; defaultValue: string }
interface FedCm { dialogType: string; title: string; subtitle: string; accounts: { email: string; name: string; picture?: string }[] }
interface Notice { level: string; text: string; stalled?: boolean }
interface SelectReq { sel: unknown; title: string; index: number; options: { label: string; disabled: boolean; group: string }[] }

const BUTTON: Record<number, string> = { 0: 'left', 1: 'middle', 2: 'right' };

/** Live view + remote control of a browser identity (CDP screencast and input). */
export function BrowserView({ profileId, compact = false, extra }: { profileId: string; compact?: boolean; extra?: React.ReactNode }) {
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
  const [fedcm, setFedcm] = useState<FedCm | null>(null);
  const [chooser, setChooser] = useState<{ multiple: boolean } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [select, setSelect] = useState<SelectReq | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [full, setFull] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const siteFull = useRef(false);
  const audioOk = useStore((s) => (s.hello as { audio?: { available: boolean; reason: string | null } } | null)?.audio);
  const av = useRemoteAudio(profileId);
  const moveQueued = useRef<null | { x: number; y: number; buttons: number }>(null);
  const touch = useRef<{ x: number; y: number; lastY: number; lastX: number; drag: boolean } | null>(null);
  // End-to-end flow control: confirm each frame once it is decoded and on screen. The server only
  // keeps a few unconfirmed frames in flight, so no buffer on the way (OS, tunnel) fills with old frames.
  const pendingAck = useRef<number | null>(null);
  const ackFrame = () => {
    const seq = pendingAck.current;
    pendingAck.current = null;
    if (seq != null) conn.send('browsers.fack', { id: profileId, seq });
  };
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [showStream, setShowStream] = useState(false);
  const [streamDraft, setStreamDraft] = useState<StreamSettings | null>(null);
  const streamTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const changeStream = (s: StreamSettings) => {
    setStreamDraft(s);
    clearTimeout(streamTimer.current);
    // slider drags: send once the value settles
    streamTimer.current = setTimeout(() => act(() => conn.call('browsers.stream', { id: profileId, stream: s })), 250);
  };
  const savedStream = JSON.stringify(profile?.stream ?? null);
  useEffect(() => setStreamDraft(null), [savedStream]); // server confirmed → show the saved value

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
        pendingAck.current = typeof m.seq === 'number' ? m.seq : null;
        if (img.current) img.current.src =`data:image/${m.fmt === 'png' ? 'png' : 'jpeg'};base64,${m.data}`;
        setHasFrame(true);
      } else if (m.t === 'bstats') {
        const s = m as unknown as StreamStats;
        setStats((prev) => (s.fps == null ? { ...s, fps: prev?.fps ?? 0, kbps: prev?.kbps ?? 0 } : s));
      } else if (m.t === 'bstate') {
        if (m.stopped) { setHasFrame(false); setState({ url: '', title: '', tabs: [] }); return; }
        setState({ url: m.url, title: m.title, tabs: m.tabs ?? [] });
        // the website went fullscreen (video, game): follow it, like a real browser would
        if (!!m.fullscreen !== siteFull.current) {
          siteFull.current = !!m.fullscreen;
          if (m.fullscreen && !document.fullscreenElement) root.current?.requestFullscreen?.().catch(() => {});
        }
      } else if (m.t === 'bdialog') {
        if (m.closed) { setDialog(null); return; }
        setDialog({ type: m.type, message: m.message, defaultValue: m.defaultValue });
        setDialogText(m.defaultValue ?? '');
      } else if (m.t === 'bfedcm') {
        setFedcm(m.closed ? null : { dialogType: m.dialogType, title: m.title, subtitle: m.subtitle, accounts: m.accounts ?? [] });
      } else if (m.t === 'bfile') {
        setChooser({ multiple: !!m.multiple });
      } else if (m.t === 'bselect') {
        setSelect({ sel: m.sel, title: m.title, index: m.index, options: m.options ?? [] });
      } else if (m.t === 'bnotice') {
        setNotice(m.clear ? null : { level: m.level, text: m.text, stalled: m.stalled });
      }
    });
    return () => { off(); conn.send('browsers.view', { id: profileId, on: false }); };
  }, [profileId, connected, profile?.running, startNonce]);

  useEffect(() => { if (!editing) setUrl(state.url === 'about:blank' ? '' : state.url); }, [state.url, editing]);

  // Fullscreen = the remote browser fills this screen: window resized to the stage, keys like Esc,
  // Ctrl+W, F11 go to the website (Keyboard Lock, where the browser supports it).
  useEffect(() => {
    const onChange = () => {
      const on = document.fullscreenElement === root.current;
      setFull(on);
      const nav = navigator as Navigator & { keyboard?: { lock?: (k?: string[]) => Promise<void>; unlock?: () => void } };
      if (on) nav.keyboard?.lock?.().catch(() => {});
      else {
        nav.keyboard?.unlock?.();
        if (siteFull.current) conn.send('browsers.nav', { id: profileId, action: 'exitFullscreen' }); // Esc leaves the site's fullscreen too
      }
      setTimeout(() => { stage.current?.focus({ preventScroll: true }); if (on && !siteFull.current) fit(); }, 250);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [profileId]);
  const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen().catch(() => {}) : root.current?.requestFullscreen?.().catch(() => {}));

  const upload = async (list: FileList | File[]) => {
    const names: string[] = [];
    for (const f of Array.from(list)) {
      const r = await fetch(`/api/browsers/${encodeURIComponent(profileId)}/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'x-cockpit': '1' }, body: f });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      names.push(j.file);
    }
    return names;
  };
  // files dragged from this computer onto the remote page land where they are dropped
  const onDrop = async (e: React.DragEvent) => {
    setDragOver(false);
    if (!e.dataTransfer.files.length || !img.current) return;
    e.preventDefault();
    const p = point(e.clientX, e.clientY);
    try { await conn.call('browsers.drop', { id: profileId, ...p, files: await upload(e.dataTransfer.files) }); } catch (err) { setError((err as Error).message); }
  };
  const answerSelect = (index: number | null) => { if (select) conn.send('browsers.select', { id: profileId, sel: select.sel, index }); setSelect(null); stage.current?.focus(); };
  const chooseFiles = async (list: FileList | null) => {
    setChooser(null);
    try {
      await conn.call('browsers.files', { id: profileId, files: await upload(list ?? []) });
    } catch (e) { setError((e as Error).message); }
  };

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
    send({ kind: 'key', type, key: e.key, code: e.code, keyCode: e.keyCode, location: e.location, text, repeat: e.repeat, ...mods(e) });
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
    <div ref={root} className={`bview${compact ? ' bview--compact' : ''}${full ? ' bview--full' : ''}`}>
      <div className="btoolbar">
        {extra}
        <button className="btn ghost icon small" title="Zurück" onClick={() => nav('back')}><ArrowLeft size={14} /></button>
        {!compact && <button className="btn ghost icon small" title="Vor" onClick={() => nav('forward')}><ArrowRight size={14} /></button>}
        <button className="btn ghost icon small" title="Neu laden" onClick={() => nav('reload')}><RotateCw size={13} /></button>
        <form className="burl" onSubmit={(e) => { e.preventDefault(); setEditing(false); nav('go', url); stage.current?.focus(); }}>
          <span className="bdot" style={{ background: profile.color }} title={profile.name} />
          <input value={url} placeholder="Adresse oder Suche" onFocus={(e) => { setEditing(true); e.target.select(); }} onBlur={() => setEditing(false)}
            onChange={(e) => setUrl(e.target.value)} spellCheck={false} aria-label="Adresse" />
        </form>
        {!compact && <button className="btn ghost icon small" title="Ansicht an Fenster anpassen" onClick={fit}><Maximize size={13} /></button>}
        <button className={`btn ghost icon small${showStream ? ' active' : ''}`} title="Stream-Qualität" aria-expanded={showStream} onClick={() => setShowStream((v) => !v)}><Gauge size={14} /></button>
        {audioOk?.available && <>
          <button className={`btn ghost icon small${av.sound ? ' active' : ''}`} title={av.sound ? 'Ton aus' : 'Ton des Browsers hier abspielen'} aria-pressed={av.sound} onClick={() => av.setSound((v) => !v)}>{av.sound ? <Volume2 size={14} /> : <VolumeX size={14} />}</button>
          <button className={`btn ghost icon small${av.cam ? ' active' : ''}`} title={av.cam ? 'Kamera aus' : 'Meine Kamera als Kamera des Browsers'} aria-pressed={av.cam} onClick={() => av.setCam((v) => !v)}>{av.cam ? <Video size={14} /> : <VideoOff size={14} />}</button>
          <button className={`btn ghost icon small${av.mic ? ' active' : ''}`} title={av.mic ? 'Mikrofon aus' : 'Mein Mikrofon als Mikrofon des Browsers'} aria-pressed={av.mic} onClick={() => av.setMic((v) => !v)}>{av.mic ? <Mic size={14} /> : <MicOff size={14} />}</button>
        </>}
        <button className="btn ghost icon small only-touch" title="Tastatur" onClick={() => kbd.current?.focus()}><Keyboard size={14} /></button>
        <button className="btn ghost icon small" title={full ? 'Vollbild beenden (Esc lange drücken)' : 'Vollbild – wie ein echter Browser'} onClick={toggleFull}>{full ? <Minimize size={13} /> : <Expand size={13} />}</button>
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
        onContextMenu={(e) => e.preventDefault()} aria-label="Ferngesteuerter Browser – klicken, dann tippen"
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        {dragOver && <div className="bdrop">Hier loslassen – die Dateien landen an dieser Stelle der Seite</div>}
        <img ref={img} alt="" draggable={false} style={{ visibility: hasFrame ? 'visible' : 'hidden' }} onLoad={ackFrame} onError={ackFrame}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onWheel={onWheel} />
        {showStream && (
          <div className="bstream" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}>
            <div className="bstream-head"><b>Stream</b><button className="btn ghost icon small" aria-label="Schließen" onClick={() => setShowStream(false)}><X size={12} /></button></div>
            <StreamStatsView stats={stats} />
            <StreamControls idPrefix={`bs-${profileId}`} value={streamDraft ?? { ...DEFAULT_STREAM, ...profile.stream }} onChange={changeStream} />
          </div>
        )}
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
        {av.error && (
          <div className="bnotice warn" role="status"><span>{av.error}</span><button className="btn ghost icon small" aria-label="Schließen" onClick={av.clearError}><X size={12} /></button></div>
        )}
        {notice && !dialog && !fedcm && (
          <div className={`bnotice ${notice.level}`} role="status">
            <span>{notice.text}</span>
            {notice.stalled && <button className="btn small" onClick={() => { setNotice(null); nav('reload'); }}>Tab neu laden</button>}
            <button className="btn ghost icon small" aria-label="Schließen" onClick={() => setNotice(null)}><X size={12} /></button>
          </div>
        )}
        {select && (
          <div className="boverlay col" onPointerDown={(e) => { if (e.target === e.currentTarget) answerSelect(null); }}>
            <div className="bdialog bselect" role="listbox" aria-label={select.title || 'Auswahl'}>
              {select.title && <b>{select.title}</b>}
              <div className="bselect-list">
                {select.options.map((o, i) => (
                  <button key={i} role="option" aria-selected={i === select.index} disabled={o.disabled} className={i === select.index ? 'on' : ''} onClick={() => answerSelect(i)}>
                    {o.group && (i === 0 || select.options[i - 1].group !== o.group) && <small>{o.group}</small>}{o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {fedcm && (
          <div className="boverlay col">
            <div className="bdialog">
              <b>{fedcm.title || 'Anmelden'}</b>
              {fedcm.subtitle && <p>{fedcm.subtitle}</p>}
              {fedcm.dialogType === 'AccountChooser' || fedcm.dialogType === 'AutoReauthn' ? (
                <div className="fedcm-list">
                  {fedcm.accounts.map((a, i) => (
                    <button key={a.email + i} className="btn" onClick={() => { setFedcm(null); conn.send('browsers.fedcm', { id: profileId, action: 'select', index: i }); }}>
                      {a.picture && <img src={a.picture} alt="" width={22} height={22} referrerPolicy="no-referrer" />}
                      <span>{a.name}<small>{a.email}</small></span>
                    </button>
                  ))}
                </div>
              ) : <p>Der Browser möchte die Anmeldung beim Anbieter bestätigen.</p>}
              <div className="perm-actions">
                {fedcm.dialogType === 'ConfirmIdpLogin' && <button className="btn primary" onClick={() => { setFedcm(null); conn.send('browsers.fedcm', { id: profileId, action: 'confirm' }); }}>Weiter</button>}
                <button className="btn" onClick={() => { setFedcm(null); conn.send('browsers.fedcm', { id: profileId, action: 'dismiss' }); }}>Schließen</button>
              </div>
            </div>
          </div>
        )}
        {chooser && (
          <div className="boverlay col">
            <div className="bdialog">
              <b>Die Seite möchte {chooser.multiple ? 'Dateien' : 'eine Datei'}</b>
              <p>Wähle sie hier aus – sie wird in den Browser übertragen.</p>
              <label className="btn primary"><Upload size={13} /> Auswählen<input type="file" hidden multiple={chooser.multiple} onChange={(e) => chooseFiles(e.target.files)} /></label>
              <div className="perm-actions"><button className="btn" onClick={() => { setChooser(null); conn.send('browsers.files', { id: profileId, files: [] }); }}>Abbrechen</button></div>
            </div>
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
