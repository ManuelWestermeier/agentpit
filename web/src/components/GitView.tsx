import { ArrowDown, ArrowUp, GitBranch, RefreshCw, RotateCcw, Upload } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { fmtAgo } from '../lib/format';
import { useActive } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import { conn } from '../lib/ws';

interface FileSt { path: string; code: string; label: string }
interface Commit { hash: string; short: string; author: string; at: number; subject: string }
interface Status { repo: boolean; branch?: string; files?: FileSt[]; log?: Commit[]; remote?: { url: string; ahead: number | null; behind: number | null } | null }

function Patch({ text }: { text: string }) {
  return (
    <div className="diff patch">
      {text.split('\n').slice(0, 3000).map((l, i) => (
        <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : 'ctx'}>{l || ' '}</div>
      ))}
    </div>
  );
}

export function GitView() {
  const { project } = useActive();
  const version = useStore((s) => s.filesVersion);
  const github = useStore((s) => s.github);
  const [st, setSt] = useState<Status | null>(null);
  const [sel, setSel] = useState<{ kind: 'file' | 'commit'; id: string } | null>(null);
  const [patch, setPatch] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [repoName, setRepoName] = useState('');
  const pid = project?.id ?? '';

  const load = useCallback(async () => {
    if (!pid) return;
    try { setSt(await conn.call<Status>('git.status', { projectId: pid })); } catch (e) { useStore.getState().toast('error', (e as Error).message); }
  }, [pid]);
  useEffect(() => { load(); }, [load, version]);
  useEffect(() => { setRepoName(project?.id ?? ''); setSel(null); }, [project?.id]);
  useEffect(() => {
    if (!sel) { setPatch(''); return; }
    const p = sel.kind === 'file' ? conn.call<string>('git.diff', { projectId: pid, file: sel.id }) : conn.call<string>('git.show', { projectId: pid, hash: sel.id });
    p.then(setPatch).catch((e) => setPatch(String(e.message)));
  }, [sel, pid, version]);

  if (!project) return null;
  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => { setBusy(label); await act(fn, ok); setBusy(''); load(); };

  if (st && !st.repo) {
    return (
      <div className="empty">
        <h2>Noch kein Git-Repository</h2>
        <p>Legt <code>.gitignore</code> an (Videos, node_modules, work/ ausgeschlossen) und committet den aktuellen Stand.</p>
        <button className="btn primary" onClick={() => run('init', () => conn.call('git.init', { projectId: pid }), 'Repository angelegt')}>Git einrichten</button>
      </div>
    );
  }

  const files = st?.files ?? [];
  return (
    <div className="gitview">
      <div className="git-left">
        <div className="git-bar">
          <GitBranch size={14} className="faint" /> <b>{st?.branch ?? '…'}</b>
          {st?.remote ? (
            <>
              <span className="faint ellipsis" title={st.remote.url}>{st.remote.url.replace(/^https:\/\/github\.com\//, '')}</span>
              <button className="btn small" disabled={!!busy} onClick={() => run('pull', () => conn.call('git.pull', { projectId: pid }), 'Aktualisiert')} title="Pull"><ArrowDown size={12} />{st.remote.behind ? st.remote.behind : ''}</button>
              <button className="btn small" disabled={!!busy} onClick={() => run('push', () => conn.call('git.push', { projectId: pid }), 'Hochgeladen')} title="Push"><ArrowUp size={12} />{st.remote.ahead ? st.remote.ahead : ''}</button>
            </>
          ) : <span className="faint">nur lokal</span>}
          <button className="u-action" style={{ marginLeft: 'auto' }} onClick={load} title="Neu laden"><RefreshCw size={11} /></button>
        </div>

        <div className="git-sec">
          <div className="u-title">Änderungen ({files.length})</div>
          {files.map((f) => (
            <div key={f.path} className={`git-file${sel?.kind === 'file' && sel.id === f.path ? ' on' : ''}`}>
              <button onClick={() => setSel({ kind: 'file', id: f.path })} title={f.label}><span className={`gcode g-${f.code === '?' ? 'A' : f.code}`}>{f.code === '?' ? 'N' : f.code}</span>{f.path}</button>
              <button className="btn ghost icon small" title="Änderung verwerfen" onClick={() => { if (window.confirm(`Änderungen an ${f.path} verwerfen?`)) run('discard', () => conn.call('git.discard', { projectId: pid, file: f.path })); }}><RotateCcw size={11} /></button>
            </div>
          ))}
          {!files.length && <div className="faint small-text">Alles committet.{project.autoCommit ? ' Auto-Commit nach jedem Turn ist an.' : ''}</div>}
          {files.length > 0 && (
            <div className="git-commit">
              <input className="input" placeholder="Commit-Nachricht" value={msg} onChange={(e) => setMsg(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && msg.trim()) run('commit', async () => { await conn.call('git.commit', { projectId: pid, message: msg }); setMsg(''); }, 'Committet'); }} />
              <button className="btn primary" disabled={!msg.trim() || !!busy} onClick={() => run('commit', async () => { await conn.call('git.commit', { projectId: pid, message: msg }); setMsg(''); }, 'Committet')}>Commit</button>
            </div>
          )}
        </div>

        <div className="git-sec grow">
          <div className="u-title">Verlauf</div>
          {(st?.log ?? []).map((c) => (
            <button key={c.hash} className={`git-log${sel?.kind === 'commit' && sel.id === c.hash ? ' on' : ''}`} onClick={() => setSel({ kind: 'commit', id: c.hash })}>
              <span className="mono faint">{c.short}</span><span className="ellipsis">{c.subject}</span><span className="faint">{fmtAgo(c.at)}</span>
            </button>
          ))}
        </div>

        {!st?.remote && (
          <div className="git-sec">
            <div className="u-title">Auf GitHub veröffentlichen</div>
            {github?.status?.loggedIn ? (
              <div className="git-commit">
                <input className="input mono" value={repoName} onChange={(e) => setRepoName(e.target.value)} aria-label="Repository-Name" />
                <button className="btn" disabled={!!busy} onClick={() => run('publish', () => conn.call('git.publish', { projectId: pid, name: repoName, private: true }, 180_000), 'Privates Repository angelegt')}><Upload size={12} /> Privat anlegen</button>
              </div>
            ) : <button className="btn small" onClick={() => useStore.setState({ loginOpen: true })}>Mit GitHub verbinden</button>}
          </div>
        )}
      </div>
      <div className="git-right">
        {sel ? (
          <>
            <div className="preview-bar">
              <span className="pname">{sel.kind === 'file' ? sel.id : sel.id.slice(0, 10)}</span>
              {sel.kind === 'commit' && <button className="btn small" onClick={() => { if (window.confirm('Diesen Commit mit einem Gegen-Commit rückgängig machen?')) run('revert', () => conn.call('git.revert', { projectId: pid, hash: sel.id }), 'Rückgängig gemacht'); }}>Rückgängig machen</button>}
            </div>
            <div className="git-patch"><Patch text={patch} /></div>
          </>
        ) : <div className="empty">Datei oder Commit wählen.</div>}
      </div>
    </div>
  );
}
