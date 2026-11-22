import { Database, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { useActive, useEscape } from '../lib/hooks';
import { act } from '../lib/store';
import { conn } from '../lib/ws';

interface DbConn { id: string; name: string; type: 'sqlite' | 'postgres' | 'mysql'; file?: string; url?: string; writable: boolean; note: string }
interface Result { columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean; ms: number }

/** Database connections of the project + query console. Claude gets the same connections via the cockpit MCP tools. */
export function DataView() {
  const { project } = useActive();
  const pid = project?.id ?? '';
  const [list, setList] = useState<DbConn[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [edit, setEdit] = useState<Partial<DbConn> | null>(null);
  const [schema, setSchema] = useState('');
  const [sql, setSql] = useState('');
  const [write, setWrite] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { if (pid) conn.call<DbConn[]>('db.list', { projectId: pid }).then((l) => { setList(l); setSel((s) => (s && l.some((c) => c.id === s) ? s : l[0]?.id ?? null)); }).catch(() => {}); }, [pid]);
  useEffect(load, [load]);
  useEffect(() => {
    setSchema(''); setRes(null); setErr(''); setWrite(false);
    if (pid && sel) conn.call<string>('db.schema', { projectId: pid, id: sel }, 40_000).then(setSchema).catch((e) => setSchema(`Fehler: ${(e as Error).message}`));
  }, [pid, sel]);
  if (!project) return null;
  const current = list.find((c) => c.id === sel);

  const run = async () => {
    if (!sel || !sql.trim()) return;
    setBusy(true); setErr('');
    try { setRes(await conn.call<Result>('db.query', { projectId: pid, id: sel, sql, write }, 40_000)); }
    catch (e) { setRes(null); setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } };

  return (
    <div className="dataview">
      <div className="svc-left">
        <div className="git-bar">
          <b>Datenbanken</b>
          <button className="btn small" style={{ marginLeft: 'auto' }} onClick={() => setEdit({ type: 'sqlite', name: '', writable: false })}><Plus size={12} /> Verbindung</button>
        </div>
        {list.map((c) => (
          <div key={c.id} className={`svc${sel === c.id ? ' on' : ''}`}>
            <button className="svc-main" onClick={() => setSel(c.id)}>
              <Database size={13} className="faint" />
              <span className="svc-name">{c.name}</span>
              <span className="svc-meta mono">{c.type === 'sqlite' ? c.file : c.url}</span>
              <span className="svc-meta">{c.type} · {c.writable ? <span style={{ color: 'var(--amber)' }}>Schreiben erlaubt</span> : 'nur lesen'}</span>
            </button>
            <div className="svc-actions"><button className="btn ghost icon small" title="Bearbeiten" onClick={() => setEdit(c)}><Pencil size={11} /></button></div>
          </div>
        ))}
        {!list.length && <div className="faint small-text" style={{ padding: '8px 14px' }}>Keine Verbindungen. Zugangsdaten liegen nur im Cockpit-Datenordner, nicht im Projekt-Repository.</div>}
        {schema && <><div className="u-title db-schema-head">Schema</div><pre className="db-schema">{schema}</pre></>}
      </div>
      <div className="svc-right db-right">
        {current ? (
          <>
            <div className="db-editor">
              <textarea className="textarea mono" rows={5} value={sql} onChange={(e) => setSql(e.target.value)} onKeyDown={onKey} placeholder="SELECT * FROM … LIMIT 50   (Strg+Enter ausführen)" aria-label="SQL" />
              <div className="db-bar">
                <label className="check" title={current.writable ? '' : 'In der Verbindung „Schreiben erlauben“ aktivieren'}>
                  <input type="checkbox" disabled={!current.writable} checked={write} onChange={(e) => setWrite(e.target.checked)} /> Schreibzugriff
                </label>
                <span className="faint small-text">{write ? 'Änderungen werden sofort festgeschrieben.' : 'Läuft in einer Read-only-Transaktion · max. 500 Zeilen · 30 s'}</span>
                <button className={`btn small ${write ? 'danger' : 'primary'}`} style={{ marginLeft: 'auto' }} disabled={busy || !sql.trim()} onClick={run}><Play size={11} /> Ausführen</button>
              </div>
            </div>
            {err && <div className="err db-err">{err}</div>}
            {res && (
              <div className="db-result">
                <div className="faint small-text db-meta">{res.rowCount} Zeile(n){res.truncated ? ' – gekürzt auf 500' : ''} · {res.ms} ms</div>
                {res.columns.length ? (
                  <div className="db-table-wrap">
                    <table className="db-table">
                      <thead><tr>{res.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                      <tbody>{res.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={v == null ? 'faint' : typeof v === 'number' ? 'num' : ''}>{v == null ? 'NULL' : String(v)}</td>)}</tr>)}</tbody>
                    </table>
                  </div>
                ) : <div className="faint small-text" style={{ padding: 12 }}>Keine Spalten.</div>}
              </div>
            )}
          </>
        ) : <div className="empty"><p>Verbindung wählen oder anlegen. Claude kann sie über die Cockpit-Tools <code>db_schema</code>, <code>db_query</code> und – nach Freigabe – <code>db_execute</code> nutzen.</p></div>}
      </div>
      {edit && <ConnDialog projectId={pid} value={edit} onClose={(changed) => { setEdit(null); if (changed) load(); }} />}
    </div>
  );
}

function ConnDialog({ projectId, value, onClose }: { projectId: string; value: Partial<DbConn>; onClose: (changed: boolean) => void }) {
  const [f, setF] = useState({ name: value.name ?? '', type: value.type ?? 'sqlite', file: value.file ?? '', url: value.url ?? '', writable: !!value.writable, note: value.note ?? '' });
  const close = useCallback(() => onClose(false), [onClose]);
  useEscape(close);
  const save = async () => { if (await act(() => conn.call('db.save', { projectId, conn: { ...f, id: value.id } })) !== undefined) onClose(true); };
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-label="Datenbank">
        <h2>{value.id ? 'Verbindung bearbeiten' : 'Neue Verbindung'}</h2>
        <div className="modal-row">
          <div><label className="label" htmlFor="db-n">Name</label><input id="db-n" className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="App-DB" /></div>
          <div><label className="label" htmlFor="db-t">Typ</label>
            <select id="db-t" className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as DbConn['type'] })}>
              <option value="sqlite">SQLite (Datei)</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL / MariaDB</option>
            </select>
          </div>
        </div>
        {f.type === 'sqlite'
          ? <><label className="label" htmlFor="db-f">Datei (relativ zum Projekt oder absolut)</label><input id="db-f" className="input mono" value={f.file} onChange={(e) => setF({ ...f, file: e.target.value })} placeholder="data/app.db" /></>
          : <><label className="label" htmlFor="db-u">Verbindungs-URL</label><input id="db-u" className="input mono" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder={f.type === 'postgres' ? 'postgres://user:pass@localhost:5432/app' : 'mysql://user:pass@localhost:3306/app'} />
              <p className="faint small-text">Empfehlung: eigener DB-Nutzer mit minimalen Rechten. Das Passwort wird im Cockpit-Datenordner gespeichert (Klartext, Dateirechte des Server-Nutzers).</p></>}
        <label className="label" htmlFor="db-no">Hinweis für Claude (optional)</label>
        <input id="db-no" className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="z. B. Staging-Kopie, Tabelle orders ist die wichtigste" />
        <label className="check"><input type="checkbox" checked={f.writable} onChange={(e) => setF({ ...f, writable: e.target.checked })} /> Schreiben erlauben (Claude fragt trotzdem vor jedem <code>db_execute</code>)</label>
        <div className="modal-actions">
          {value.id && <button className="btn danger" style={{ marginRight: 'auto' }} onClick={async () => { if (await act(() => conn.call('db.remove', { projectId, id: value.id })) !== undefined) onClose(true); }}><Trash2 size={12} /> Löschen</button>}
          <button className="btn ghost" onClick={close}>Abbrechen</button>
          <button className="btn primary" disabled={!f.name.trim()} onClick={save}>Speichern</button>
        </div>
      </div>
    </div>
  );
}
