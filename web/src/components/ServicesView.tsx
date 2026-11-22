import { Copy, Globe, MessageSquareShare, Pencil, Play, Plus, RotateCw, Square, SquareTerminal, Trash2 } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { fmtAgo } from '../lib/format';
import { useActive, useEscape } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import type { ServiceInfo } from '../lib/types';
import { conn } from '../lib/ws';
import { SchedulesPanel } from './SchedulesPanel';

const TerminalPanel = lazy(() => import('./TerminalPanel'));
const LAMP: Record<string, string> = { running: 'ready', starting: 'running', crashed: 'error', exited: '', stopped: '' };
const LABEL: Record<string, string> = { running: 'läuft', starting: 'startet', crashed: 'abgestürzt', exited: 'beendet', stopped: 'aus' };

export default function ServicesView() {
  const { project } = useActive();
  const pid = project?.id ?? '';
  const services = useStore((s) => s.services[pid]);
  const terminals = useStore((s) => s.hello?.config.terminals);
  const [sel, setSel] = useState<string | null>(null);
  const [edit, setEdit] = useState<Partial<ServiceInfo> | null>(null);
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const [allList, setAllList] = useState<ServiceInfo[]>([]);

  useEffect(() => {
    if (!pid) return;
    conn.call<ServiceInfo[]>('svc.list', { projectId: pid }).then((list) => useStore.setState((s) => ({ services: { ...s.services, [pid]: list } }))).catch(() => {});
  }, [pid]);
  useEffect(() => { setSel(null); }, [pid, scope]);
  // overview of all projects: initial list + live updates per project
  useEffect(() => {
    if (scope !== 'all') return;
    conn.call<ServiceInfo[]>('svc.listAll').then(setAllList).catch(() => {});
    const off = conn.onMessage((m) => {
      if (m.t !== 'services_all') return;
      setAllList((cur) => {
        const name = cur.find((s) => s.projectId === m.projectId)?.projectName ?? m.projectId;
        return [...cur.filter((s) => s.projectId !== m.projectId), ...(m.services as ServiceInfo[]).map((s) => ({ ...s, projectId: m.projectId, projectName: name }))];
      });
    });
    return () => { off(); };
  }, [scope]);
  if (!project) return null;

  const list = scope === 'all' ? allList : (services ?? []).map((s) => ({ ...s, projectId: pid }));
  const keyOf = (s: ServiceInfo) => `${s.projectId}/${s.id}`;
  const current = list.find((s) => keyOf(s) === sel);
  const openInBrowser = async (url: string) => {
    const profileId = project.browserProfile || useStore.getState().browsers?.profiles[0]?.id;
    if (!profileId) return;
    await act(() => conn.call('browsers.view', { id: profileId, on: true }, 60_000).then(() => conn.call('browsers.nav', { id: profileId, action: 'go', url })));
    conn.send('browsers.view', { id: profileId, on: false });
    if (project.browserProfile) useStore.setState({ tab: 'browser' });
    else useStore.setState({ profileView: profileId });
  };

  return (
    <div className="svcview">
      <div className="svc-left">
        <div className="git-bar">
          <div className="seg" role="radiogroup" aria-label="Bereich">
            <button type="button" role="radio" aria-checked={scope === 'project'} className={scope === 'project' ? 'on' : ''} onClick={() => setScope('project')}>Projekt</button>
            <button type="button" role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>Alle Projekte</button>
          </div>
          {scope === 'project' && <button className="btn small" style={{ marginLeft: 'auto' }} onClick={() => setEdit({ name: '', command: '' })}><Plus size={12} /> Service</button>}
        </div>
        {list.map((s) => {
          const spid = s.projectId ?? pid;
          const h = s.healthState;
          return (
            <div key={keyOf(s)} className={`svc${sel === keyOf(s) ? ' on' : ''}`}>
              <button className="svc-main" onClick={() => setSel(keyOf(s))}>
                <span className={`tally ${s.status === 'running' && h && !h.ok ? 'error' : LAMP[s.status] || 'none'}`} />
                <span className="svc-name">{s.name}{scope === 'all' && <span className="faint"> · {s.projectName}</span>}</span>
                <span className="svc-meta mono">{s.port ? `:${s.port} · ` : ''}{s.command}</span>
                <span className="svc-meta">
                  {LABEL[s.status]}{s.startedAt && s.status === 'running' ? ` seit ${fmtAgo(s.startedAt).replace('vor ', '')}` : ''}{s.exitCode != null && s.status !== 'running' ? ` (Code ${s.exitCode})` : ''}
                  {s.status === 'running' && h && <span className={h.ok ? '' : 'err'}> · {h.ok ? `gesund, ${h.ms} ms` : `antwortet nicht${h.code ? ` (${h.code})` : ''}`}</span>}
                  {s.restarts ? ` · ${s.restarts}× neu gestartet` : ''}
                </span>
              </button>
              <div className="svc-actions">
                {s.status === 'running' || s.status === 'starting'
                  ? <><button className="btn ghost icon small" title="Stoppen" onClick={() => act(() => conn.call('svc.stop', { projectId: spid, id: s.id }))}><Square size={11} fill="currentColor" /></button>
                      <button className="btn ghost icon small" title="Neu starten" onClick={() => act(() => conn.call('svc.restart', { projectId: spid, id: s.id }))}><RotateCw size={12} /></button></>
                  : <button className="btn ghost icon small" title="Starten" onClick={() => { setSel(keyOf(s)); act(() => conn.call('svc.start', { projectId: spid, id: s.id })); }}><Play size={12} /></button>}
                {(s.url || s.detectedUrl) && <button className="btn ghost icon small" title="Im Browser des Servers öffnen" onClick={() => openInBrowser(s.url || s.detectedUrl!)}><Globe size={12} /></button>}
                {spid === pid && <button className="btn ghost icon small" title="Bearbeiten" onClick={() => setEdit(s)}><Pencil size={11} /></button>}
              </div>
            </div>
          );
        })}
        {scope === 'all' && !list.length && <p className="small-text muted" style={{ padding: '12px 14px' }}>In keinem Projekt sind Dienste angelegt.</p>}
        {scope === 'project' && terminals && <button className={`svc-term${sel === '__term' ? ' on' : ''}`} onClick={() => setSel('__term')}><SquareTerminal size={13} /> Terminal</button>}
        {scope === 'project' && <SchedulesPanel projectId={pid} />}
        {scope === 'project' && <HookInfo projectId={pid} />}
      </div>
      <div className="svc-right">
        {sel === '__term' ? <Suspense fallback={null}><TerminalPanel key={pid} /></Suspense>
          : current ? <Logs projectId={current.projectId ?? pid} service={current} foreign={(current.projectId ?? pid) !== pid} /> : <div className="empty" />}
      </div>
      {edit && <ServiceDialog projectId={pid} service={edit} others={(services ?? []).filter((x) => x.id !== edit.id)} onClose={() => setEdit(null)} />}
    </div>
  );
}

function Logs({ projectId, service, foreign }: { projectId: string; service: ServiceInfo; foreign: boolean }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let buf = '';
    const load = () => conn.call<string>('svc.logs', { projectId, id: service.id }).then((t) => { buf = t; setText(t); }).catch(() => {});
    load();
    const off = conn.onMessage((m) => {
      if (m.t === 'svclog' && m.projectId === projectId && m.id === service.id) { buf = (buf + m.text).slice(-200_000); setText(buf); }
    });
    // log lines are only pushed for the open project – poll services of other projects ("Alle Projekte")
    const poll = foreign ? setInterval(load, 2000) : null;
    return () => { off(); if (poll) clearInterval(poll); };
  }, [projectId, service.id, foreign]);
  useEffect(() => { const el = ref.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight; }, [text]);
  const toClaude = () => {
    const tail = text.split('\n').slice(-80).join('\n');
    act(() => conn.call('send', { projectId, text: `Logs des Dienstes „${service.name}“ (${service.command}), Status: ${LABEL[service.status]}. Bitte prüfen und Fehler beheben:\n\n\`\`\`\n${tail}\n\`\`\`` }), 'An die Session gesendet');
    useStore.setState({ tab: 'session' });
  };
  return (
    <div className="preview">
      <div className="preview-bar">
        <span className="pname">{service.name} · {LABEL[service.status]}</span>
        <button className="btn small" onClick={toClaude} title="Letzte 80 Zeilen als Prompt an Claude"><MessageSquareShare size={12} /> An Claude</button>
      </div>
      <pre className="svc-log" ref={ref}>{text || '(noch keine Ausgabe)'}</pre>
    </div>
  );
}

function HookInfo({ projectId }: { projectId: string }) {
  const [info, setInfo] = useState<{ url: string; publicUrl: string | null; token: string } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open && !info) conn.call('project.hook', { projectId }).then(setInfo).catch(() => {}); }, [open, info, projectId]);
  const snippet = info ? `fetch(process.env.COCKPIT_HOOK_URL ?? '${info.url}', {\n  method: 'POST',\n  headers: { Authorization: 'Bearer ' + (process.env.COCKPIT_HOOK_TOKEN ?? '${info.token}'), 'Content-Type': 'application/json' },\n  body: JSON.stringify({ from: 'Test-UI', text: 'Button X wirft einen Fehler – bitte prüfen' }),\n})` : '';
  return (
    <details className="hook" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Prompts aus Diensten an Claude senden</summary>
      {info && (
        <>
          <p className="small-text muted">Jeder Dienst bekommt <code>COCKPIT_HOOK_URL</code> und <code>COCKPIT_HOOK_TOKEN</code>. Ein POST mit <code>{'{ text, from }'}</code> landet als Prompt in der Session (läuft sie gerade, wird er eingereiht).</p>
          <pre className="out-pre hook-code">{snippet}</pre>
          <button className="btn small" onClick={() => navigator.clipboard?.writeText(snippet).then(() => useStore.getState().toast('info', 'Kopiert'))}><Copy size={11} /> Kopieren</button>
        </>
      )}
    </details>
  );
}

function ServiceDialog({ projectId, service, others, onClose }: { projectId: string; service: Partial<ServiceInfo>; others: ServiceInfo[]; onClose: () => void }) {
  const [f, setF] = useState({
    name: service.name ?? '', command: service.command ?? '', cwd: service.cwd ?? '', url: service.url ?? '', autostart: !!service.autostart,
    env: Object.entries(service.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    port: service.port ? String(service.port) : '', health: service.health ?? '', restart: service.restart ?? 'no', dependsOn: service.dependsOn ?? [],
  });
  const close = useCallback(onClose, [onClose]);
  useEscape(close);
  const save = async () => {
    const env = Object.fromEntries(f.env.split('\n').map((l) => l.trim()).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    if (await act(() => conn.call('svc.save', { projectId, service: { ...f, env, port: f.port ? Number(f.port) : null, id: service.id } })) !== undefined) onClose();
  };
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Service">
        <h2>{service.id ? 'Service bearbeiten' : 'Neuer Service'}</h2>
        <div className="modal-row">
          <div><label className="label" htmlFor="sv-n">Name</label><input id="sv-n" className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Dev-Server" /></div>
          <div><label className="label" htmlFor="sv-c">Unterordner</label><input id="sv-c" className="input mono" value={f.cwd} onChange={(e) => setF({ ...f, cwd: e.target.value })} placeholder="(Projektordner)" /></div>
        </div>
        <label className="label" htmlFor="sv-cmd">Befehl</label>
        <input id="sv-cmd" className="input mono" value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} placeholder="npm run dev -- --port 5173" />
        <div className="modal-row" style={{ marginTop: 12 }}>
          <div><label className="label" htmlFor="sv-u">URL (sonst aus Logs erkannt)</label><input id="sv-u" className="input mono" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="http://localhost:5173" /></div>
          <div><label className="label" htmlFor="sv-e">Umgebung (KEY=Wert je Zeile)</label><textarea id="sv-e" className="textarea mono" rows={2} value={f.env} onChange={(e) => setF({ ...f, env: e.target.value })} /></div>
        </div>
        <label className="check"><input type="checkbox" checked={f.autostart} onChange={(e) => setF({ ...f, autostart: e.target.checked })} /> Beim Start des Cockpits mitstarten</label>
        <details className="svc-adv" open={!!(service.port || service.health || (service.restart && service.restart !== 'no') || service.dependsOn?.length)}>
          <summary>Erweitert</summary>
          <div className="modal-row">
            <div><label className="label" htmlFor="sv-p">Port (→ PORT)</label><input id="sv-p" className="input mono" inputMode="numeric" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value.replace(/\D/g, '') })} placeholder="3000" /></div>
            <div><label className="label" htmlFor="sv-h">Health-Check</label><input id="sv-h" className="input mono" value={f.health} onChange={(e) => setF({ ...f, health: e.target.value })} placeholder="/health" /></div>
          </div>
          <div className="modal-row">
            <div>
              <label className="label" htmlFor="sv-r">Neustart</label>
              <select id="sv-r" className="select" value={f.restart} onChange={(e) => setF({ ...f, restart: e.target.value as 'no' | 'on-failure' | 'always' })}>
                <option value="no">nie</option><option value="on-failure">bei Absturz</option><option value="always">immer</option>
              </select>
            </div>
            {others.length > 0 && (
              <div>
                <label className="label" htmlFor="sv-d">Startet nach</label>
                <select id="sv-d" className="select" multiple size={Math.min(3, others.length)} value={f.dependsOn}
                  onChange={(e) => setF({ ...f, dependsOn: [...e.target.selectedOptions].map((o) => o.value) })}>
                  {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
            )}
          </div>
        </details>
        <div className="modal-actions">
          {service.id && <button className="btn danger" style={{ marginRight: 'auto' }} onClick={async () => { if (await act(() => conn.call('svc.remove', { projectId, id: service.id })) !== undefined) onClose(); }}><Trash2 size={12} /> Löschen</button>}
          <button className="btn ghost" onClick={onClose}>Abbrechen</button>
          <button className="btn primary" disabled={!f.name.trim() || !f.command.trim()} onClick={save}>Speichern</button>
        </div>
      </div>
    </div>
  );
}
