import { Clock, Pause, Play, Plus, Trash2, Zap } from 'lucide-react';
import { useCallback, useState } from 'react';
import { fmtAgo } from '../lib/format';
import { useEscape } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import type { Schedule } from '../lib/types';
import { conn } from '../lib/ws';

const fmtTime = (t: number | null | undefined) => (t ? new Date(t).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');

function when(s: Schedule) {
  if (s.kind === 'at') return `einmalig ${fmtTime(s.at)}`;
  if (s.kind === 'every') return s.everyMinutes! % 60 === 0 ? `alle ${s.everyMinutes! / 60} h` : `alle ${s.everyMinutes} min`;
  return `Cron ${s.cron}`;
}

/** Timed prompts to this project's Claude session – created here or by Claude (schedule_create). */
export function SchedulesPanel({ projectId }: { projectId: string }) {
  const all = useStore((s) => s.schedules);
  const list = all.filter((s) => s.projectId === projectId);
  const [open, setOpen] = useState(false);
  const toggle = (s: Schedule) => act(() => conn.call('schedules.update', { id: s.id, patch: { enabled: !s.enabled } }));
  return (
    <div className="sched">
      <div className="git-bar">
        <b>Zeitpläne</b><span className="faint">Prompts zu festen Zeiten</span>
        <button className="btn small" style={{ marginLeft: 'auto' }} onClick={() => setOpen(true)}><Plus size={12} /> Zeitplan</button>
      </div>
      {list.map((s) => (
        <div key={s.id} className={`sched-item${s.enabled ? '' : ' off'}`}>
          <div className="sched-main">
            <span className="sched-name"><Clock size={11} /> {s.name}</span>
            <span className="svc-meta">{when(s)} · {s.enabled ? `nächster Lauf ${fmtTime(s.nextRun)}` : 'pausiert'}{s.runs ? ` · ${s.runs}× gelaufen, zuletzt ${fmtAgo(s.lastRun!)}` : ''}</span>
            <span className="svc-meta" title={s.prompt}>„{s.prompt.split('\n')[0].slice(0, 90)}“ · von {s.createdBy}</span>
            {s.lastError && <span className="svc-meta err">Fehler: {s.lastError}</span>}
          </div>
          <div className="svc-actions">
            <button className="btn ghost icon small" title="Jetzt ausführen" onClick={() => act(() => conn.call('schedules.run', { id: s.id }), 'An die Session gesendet')}><Zap size={12} /></button>
            <button className="btn ghost icon small" title={s.enabled ? 'Pausieren' : 'Fortsetzen'} onClick={() => toggle(s)}>{s.enabled ? <Pause size={12} /> : <Play size={12} />}</button>
            <button className="btn ghost icon small" title="Löschen" onClick={() => act(() => conn.call('schedules.remove', { id: s.id }))}><Trash2 size={12} /></button>
          </div>
        </div>
      ))}
      {open && <ScheduleDialog projectId={projectId} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ScheduleDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const soon = new Date(Date.now() + 3600_000);
  soon.setMinutes(0, 0, 0);
  const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [f, setF] = useState({ name: '', prompt: '', kind: 'cron' as Schedule['kind'], cron: '0 9 * * 1-5', everyMinutes: 60, at: local });
  const close = useCallback(onClose, [onClose]);
  useEscape(close);
  const save = async () => {
    const schedule = { name: f.name, prompt: f.prompt, kind: f.kind, ...(f.kind === 'cron' ? { cron: f.cron } : f.kind === 'every' ? { everyMinutes: f.everyMinutes } : { at: new Date(f.at).toISOString() }) };
    if (await act(() => conn.call('schedules.create', { projectId, schedule })) !== undefined) onClose();
  };
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Zeitplan">
        <h2>Neuer Zeitplan</h2>
        <p>Schickt den Prompt zur gewählten Zeit an die Claude-Session dieses Projekts (läuft sie gerade, wird er eingereiht). Ortszeit des Servers.</p>
        <label className="label" htmlFor="sc-n">Name</label>
        <input id="sc-n" className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Morgen-Recherche" />
        <label className="label" htmlFor="sc-p" style={{ marginTop: 10 }}>Prompt</label>
        <textarea id="sc-p" className="textarea" rows={4} value={f.prompt} onChange={(e) => setF({ ...f, prompt: e.target.value })} placeholder="Recherchiere die 5 meistgesehenen Videos zu … und lege die Links in ../shared-claude/pipelines/videos/ ab." />
        <div className="modal-row" style={{ marginTop: 10 }}>
          <div>
            <label className="label" htmlFor="sc-k">Wann</label>
            <select id="sc-k" className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Schedule['kind'] })}>
              <option value="cron">Wiederkehrend (Cron)</option>
              <option value="every">Alle n Minuten</option>
              <option value="at">Einmalig</option>
            </select>
          </div>
          <div>
            {f.kind === 'cron' && <><label className="label" htmlFor="sc-c">Cron (Minute Stunde Tag Monat Wochentag)</label><input id="sc-c" className="input mono" value={f.cron} onChange={(e) => setF({ ...f, cron: e.target.value })} /></>}
            {f.kind === 'every' && <><label className="label" htmlFor="sc-e">Minuten</label><input id="sc-e" className="input" type="number" min={1} value={f.everyMinutes} onChange={(e) => setF({ ...f, everyMinutes: Number(e.target.value) })} /></>}
            {f.kind === 'at' && <><label className="label" htmlFor="sc-a">Zeitpunkt</label><input id="sc-a" className="input" type="datetime-local" value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} /></>}
          </div>
        </div>
        {f.kind === 'cron' && <p className="stream-hint">Beispiele: <code>0 9 * * 1-5</code> werktags 9:00 · <code>*/30 * * * *</code> alle 30 min · <code>0 18 * * 0</code> sonntags 18:00</p>}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Abbrechen</button>
          <button className="btn primary" disabled={!f.prompt.trim()} onClick={save}>Anlegen</button>
        </div>
      </div>
    </div>
  );
}
