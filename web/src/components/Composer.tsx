import { CornerDownLeft, Paperclip, Square } from 'lucide-react';
import { useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { estimate } from '../lib/forecast';
import { fmtCountdown, fmtPct, fmtTokens, fmtUsd } from '../lib/format';
import { useActive, useNow } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import { conn } from '../lib/ws';

const QUICK: { cmd: string; title: string }[] = [
  { cmd: '/compact', title: 'Verlauf zusammenfassen – macht Kontext frei, senkt Kosten pro Turn' },
  { cmd: '/context', title: 'Wofür der Kontext gerade verbraucht wird' },
  { cmd: '/usage', title: 'Kosten der Session und Plan-Limits als Text' },
  { cmd: '/init', title: 'CLAUDE.md für dieses Projekt erzeugen oder aktualisieren' },
];

async function upload(projectId: string, file: File) {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/upload?name=${encodeURIComponent(file.name || 'einfuegen.png')}`, {
    method: 'POST',
    headers: { 'X-Cockpit': '1', 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload fehlgeschlagen (${res.status})`);
  return data.path as string;
}

export function Composer() {
  const { project, runner } = useActive();
  const projectId = project?.id ?? '';
  const text = useStore((s) => s.draft[projectId] ?? '');
  const catalog = useStore((s) => s.catalog);
  const limits = useStore((s) => s.limits);
  const view = useStore((s) => s.view);
  const [slashIdx, setSlashIdx] = useState(0);
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const now = useNow(1000);

  const setText = (v: string) => useStore.setState((s) => ({ draft: { ...s.draft, [projectId]: v } }));
  const busy = runner?.state === 'running' || runner?.state === 'waiting' || !!runner?.compacting;
  const readOnly = !!view && !view.follow && !!runner?.live && runner.sessionId !== view.sessionId;
  const stats = runner?.stats ?? null;

  const commands = useMemo(() => {
    const desc = new Map((catalog?.commands ?? []).map((c) => [c.name, c] as const));
    const names = runner?.commands?.length ? runner.commands : (catalog?.commands ?? []).map((c) => c.name);
    return names.map((n) => ({ name: n, description: desc.get(n)?.description ?? '', hint: desc.get(n)?.argumentHint ?? '' }));
  }, [catalog, runner?.commands]);
  const slashQuery = /^\/[\w:-]*$/.test(text) ? text.slice(1).toLowerCase() : null;
  const slashMatches = slashQuery == null ? [] : commands.filter((c) => c.name.toLowerCase().includes(slashQuery)).slice(0, 40);

  const est = estimate(stats, catalog, limits, text.length, runner?.model ?? project?.model ?? null, now);

  if (!project) return null;

  const send = async (value = text) => {
    const v = value.trim();
    if (!v) return;
    if (v === '/clear' || v === '/new' || v === '/reset') {
      setText('');
      await act(() => conn.call('session.new', { projectId }));
      return;
    }
    setText('');
    const ok = await act(() => conn.call('send', { projectId, text: v }));
    if (ok === undefined) setText(v);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMatches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashMatches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && slashMatches[slashIdx] && `/${slashMatches[slashIdx].name}` !== text)) {
        e.preventDefault();
        setText(`/${slashMatches[slashIdx].name} `);
        setSlashIdx(0);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && busy) {
      e.preventDefault();
      act(() => conn.call('interrupt', { projectId }), 'Unterbrochen');
    }
  };

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploading((n) => n + files.length);
    const paths: string[] = [];
    for (const f of files) {
      const p = await act(() => upload(projectId, f));
      if (p) paths.push(p);
      setUploading((n) => n - 1);
    }
    if (paths.length) {
      const cur = useStore.getState().draft[projectId] ?? '';
      setText(`${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${paths.map((p) => `Datei: ${p}`).join('\n')}\n`);
      ta.current?.focus();
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) { e.preventDefault(); addFiles(files); }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    addFiles([...e.dataTransfer.files]);
  };

  return (
    <div className="composer">
      {runner?.suggestion && !text && (
        <div className="suggest"><span className="faint">Vorschlag</span><button className="btn ghost small" onClick={() => setText(runner.suggestion!)}>{runner.suggestion}</button></div>
      )}
      <div className="cmdbar" role="toolbar" aria-label="Befehle">
        {QUICK.map((q) => (
          <button key={q.cmd} className="cmd" title={q.title} disabled={readOnly || (!runner?.sessionId && q.cmd !== '/init')} onClick={() => send(q.cmd)}>{q.cmd}</button>
        ))}
        <button className="cmd" title="Neue Session – bei laufendem Prozess per /clear" disabled={readOnly} onClick={() => send('/clear')}>/clear</button>
        <button className="cmd" title="Alle Befehle und Skills" onClick={() => { setText('/'); ta.current?.focus(); }}>Befehle …</button>
        <span className="sep" />
        {busy && (
          <button className="cmd stop" title="Aktuellen Schritt abbrechen (Esc)" onClick={() => act(() => conn.call('interrupt', { projectId }), 'Unterbrochen')}>
            <Square size={10} fill="currentColor" /> Stopp
          </button>
        )}
      </div>
      <div className={`composer-box${drag ? ' drag' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
        {slashMatches.length > 0 && (
          <div className="slash" role="listbox">
            {slashMatches.map((c, i) => (
              <button key={c.name} className={i === slashIdx ? 'on' : ''} role="option" aria-selected={i === slashIdx}
                onMouseDown={(e) => { e.preventDefault(); setText(`/${c.name} `); ta.current?.focus(); }}>
                <code>/{c.name}{c.hint ? ` ${c.hint}` : ''}</code><span>{c.description}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          value={text}
          disabled={readOnly}
          placeholder={readOnly ? 'Nur Ansicht – oben „Diese fortsetzen“ wählen' : busy ? 'Nachricht einreihen – wird nach dem aktuellen Schritt verarbeitet (Esc bricht ab)' : 'Aufgabe für Claude … (Enter senden, Shift+Enter Zeile, / für Befehle)'}
          rows={Math.min(12, Math.max(2, text.split('\n').length))}
          onChange={(e) => { setText(e.target.value); setSlashIdx(0); }}
          onKeyDown={onKey}
          onPaste={onPaste}
          aria-label="Prompt"
        />
        <div className="composer-foot">
          <label className="btn ghost icon small" title="Datei nach input/ hochladen">
            <Paperclip size={14} />
            <input type="file" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
          </label>
          <div className="estimate" aria-live="off">
            {uploading > 0 && <span>lädt {uploading} Datei(en) …</span>}
            {text && <span><b>{fmtTokens(est.draftTokens)}</b> Tokens</span>}
            {est.single != null && <span title="Ein API-Call mit aktuellem Kontext (API-Gegenwert)">nächster Call ≈ <b>{fmtUsd(est.single)}</b></span>}
            {est.typical != null && <span title="Median der bisherigen Turns, auf den aktuellen Kontext skaliert">Ø Turn ≈ <b>{fmtUsd(est.typical)}</b>{est.avgCalls ? ` (${Math.round(est.avgCalls)} Calls)` : ''}</span>}
            {est.pctOf5h != null && <span title="Aus gemessenem Verbrauch pro Dollar in diesem 5-h-Fenster">≈ <b>+{fmtPct(est.pctOf5h, 1)}</b> 5-h-Limit</span>}
            {est.ctxTokens > 0 && (est.warm
              ? <span title={`Prompt-Cache (${est.ttl}) noch gültig – Kontext wird günstig gelesen`}>Cache warm <b className="tab-nums">{fmtCountdown(est.warmLeftMs)}</b></span>
              : <span className="cold" title="Cache abgelaufen – der nächste Call schreibt den ganzen Kontext neu">Cache kalt{est.coldExtra ? ` +${fmtUsd(est.coldExtra)}` : ''}</span>)}
          </div>
          <button className="btn primary" disabled={!text.trim() || readOnly} onClick={() => send()} title="Senden (Enter)">
            {busy ? 'Einreihen' : 'Senden'} <CornerDownLeft size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
