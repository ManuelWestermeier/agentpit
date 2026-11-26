import { CornerDownLeft, Paperclip, Square } from 'lucide-react';
import { useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { estimate } from '../lib/forecast';
import { MODE_LABEL, fmtPct, fmtUsd, shortModel } from '../lib/format';
import { useActive, useNow } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import { useModeSwitch } from './Permissions';
import { conn } from '../lib/ws';

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
        <button className="cmd" title="Alle Befehle und Skills (/compact, /context, /clear …) – oder „/“ tippen" onClick={() => { setText('/'); ta.current?.focus(); }}>Befehle …</button>
        <span className="sep" />
        <RunSettings />
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
          placeholder={readOnly ? 'Nur Ansicht – oben „Diese fortsetzen“ wählen' : busy ? 'Nachricht einreihen' : 'Aufgabe für Claude'}
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
            {/* only what changes a decision: the expected share of the 5-h limit, and a warning when the cache went cold
                (details: usage panel, top right) */}
            {est.pctOf5h != null && <span title="Geschätzt aus dem gemessenen Verbrauch in diesem 5-h-Fenster">≈ <b>+{fmtPct(est.pctOf5h, 1)}</b> 5-h-Limit</span>}
            {est.ctxTokens > 0 && !est.warm && (
              <span className="cold" title="Prompt-Cache abgelaufen – der nächste Schritt liest den ganzen Kontext neu ein">Cache kalt{est.coldExtra ? ` +${fmtUsd(est.coldExtra)}` : ''}</span>
            )}
          </div>
          <button className="btn primary" disabled={!text.trim() || readOnly} onClick={() => send()} title="Senden (Enter)">
            {busy ? 'Einreihen' : 'Senden'} <CornerDownLeft size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Model, permission mode and effort – compact, right next to where you type. */
function RunSettings() {
  const { project, runner } = useActive();
  const catalog = useStore((s) => s.catalog);
  const cfg = useStore((s) => s.hello?.config);
  if (!project || !cfg) return null;
  const pid = project.id;
  const model = runner?.live ? runner.model ?? project.model : project.model;
  const mode = runner?.live ? runner.mode : project.mode;
  const effort = runner?.live ? runner.effort : project.effort;
  const models = (catalog?.models ?? []).filter((m) => m.value !== 'default');
  const cur = models.find((m) => m.value === model || m.resolvedModel === model);
  const efforts = cur?.supportsEffort ? cur.supportedEffortLevels : (catalog?.models ?? []).find((m) => m.supportsEffort)?.supportedEffortLevels ?? [];
  const modes = cfg.permissionModes;
  return (
    <div className="runset">
      <select className="mini-select" value={cur?.value ?? model ?? ''} title="Modell" aria-label="Modell"
        onChange={(e) => act(() => conn.call('setModel', { projectId: pid, model: e.target.value }))}>
        <option value="">Standard</option>
        {models.map((m) => <option key={m.value} value={m.value}>{m.displayName}</option>)}
        {model && !cur && <option value={model}>{shortModel(model)}</option>}
      </select>
      <ModeSelect projectId={pid} mode={mode} modes={modes} allowBypass={cfg.allowBypass} />
      {efforts.length > 0 && (
        <select className="mini-select" value={effort} title="Denkaufwand (Effort)" aria-label="Effort"
          onChange={(e) => act(() => conn.call('setEffort', { projectId: pid, effort: e.target.value }))}>
          <option value="">Effort: Standard</option>
          {efforts.map((l) => <option key={l} value={l}>Effort: {l}</option>)}
        </select>
      )}
      <TurnLimits />
    </div>
  );
}

/** Permission mode; "Alles erlauben" stays visible while locked and explains how to unlock it. */
function ModeSelect({ projectId, mode, modes, allowBypass }: { projectId: string; mode: string; modes: string[]; allowBypass: boolean }) {
  const sw = useModeSwitch(projectId);
  return (
    <span className="mode-wrap">
      <select className="mini-select" value={mode} title="Freigabe-Modus – gilt sofort für die laufende Session" aria-label="Freigabe-Modus"
        onChange={(e) => sw.set(e.target.value)}>
        {modes.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}{m === 'bypassPermissions' && !allowBypass ? ' (gesperrt)' : ''}</option>)}
      </select>
      {sw.panel}
    </span>
  );
}

const LIMIT_FIELDS: [keyof TurnLimitSet, string, string, number][] = [
  ['costUsd', 'Kosten', '$', 0.05],
  ['usagePct', '5-h-Limit', '%', 0.5],
  ['minutes', 'Zeit', 'min', 1],
  ['calls', 'Schritte', '', 1],
];
type TurnLimitSet = { costUsd: number; usagePct: number; minutes: number; calls: number };

/** Per-answer limits: the running answer stops as soon as one is reached (0 / empty = no limit). */
function TurnLimits() {
  const { project, runner } = useActive();
  const [open, setOpen] = useState(false);
  const cur: TurnLimitSet = { costUsd: 0, usagePct: 0, minutes: 0, calls: 0, ...(project?.turnLimits ?? {}) };
  const [draft, setDraft] = useState(cur);
  if (!project) return null;
  const active = LIMIT_FIELDS.filter(([k]) => cur[k] > 0);
  const label = active.length ? active.map(([k, , unit]) => `${k === 'costUsd' ? '≤ ' : ''}${cur[k]}${unit ? ` ${unit}` : ' Schritte'}`).join(' · ') : 'Limit';
  const est = runner?.turn?.estCost;
  const save = async () => {
    await act(() => conn.call('project.update', { projectId: project.id, patch: { turnLimits: draft } }));
    setOpen(false);
  };
  return (
    <span className="limits">
      <button className={`mini-select limits-btn${active.length ? ' on' : ''}`} title="Limits pro Antwort" aria-expanded={open}
        onClick={() => { setDraft(cur); setOpen((v) => !v); }}>
        {label}{runner?.turn && cur.costUsd > 0 && est != null ? ` (${est.toFixed(2)} $)` : ''}
      </button>
      {open && (
        <div className="limits-pop" role="dialog" aria-label="Limits pro Antwort">
          <b>Pro Antwort höchstens</b>
          {LIMIT_FIELDS.map(([k, name, unit, step]) => (
            <label key={k} className="limits-row">
              <span>{name}</span>
              <input className="input" type="number" min={0} step={step} value={draft[k] || ''} placeholder="aus"
                onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) || 0 })} />
              <span className="faint">{unit}</span>
            </label>
          ))}
          <div className="limits-actions">
            <button className="btn ghost small" onClick={() => setDraft({ costUsd: 0, usagePct: 0, minutes: 0, calls: 0 })}>Alle aus</button>
            <button className="btn primary small" onClick={save}>Übernehmen</button>
          </div>
        </div>
      )}
    </span>
  );
}
