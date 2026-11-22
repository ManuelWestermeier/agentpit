import { File, FileImage, FileVideo, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { fmtAgo, fmtBytes } from '../lib/format';
import { previewUrl } from '../lib/hooks';
import { useStore } from '../lib/store';
import type { FileEntry } from '../lib/types';
import { conn } from '../lib/ws';

const VIDEO = /\.(mp4|webm|mov|m4v|mkv)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

function iconFor(e: FileEntry) {
  if (e.dir) return <Folder size={14} />;
  if (VIDEO.test(e.name)) return <FileVideo size={14} />;
  if (IMAGE.test(e.name)) return <FileImage size={14} />;
  return <File size={14} />;
}

export function FilesPanel() {
  const projectId = useStore((s) => s.activeId);
  const version = useStore((s) => s.filesVersion);
  const preview = useStore((s) => s.preview);
  const base = useStore((s) => s.hello?.config.previewBase ?? '');
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [recent, setRecent] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setPath(''); }, [projectId]);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [list, out] = await Promise.all([
        conn.call<{ entries: FileEntry[] }>('files', { projectId, path }),
        conn.call<FileEntry[]>('outputs', { projectId }).catch(() => []),
      ]);
      setEntries(list.entries);
      setRecent(out.filter((f) => VIDEO.test(f.name) || IMAGE.test(f.name)).slice(0, 6));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      if (path) setPath('');
    }
  }, [projectId, path]);

  useEffect(() => { load(); }, [load, version]);

  const open = (e: FileEntry) => {
    if (e.dir) setPath(e.path);
    else useStore.setState({ preview: { path: e.path, at: Date.now() } });
  };
  const crumbs = path ? path.split('/') : [];

  return (
    <div className="files">
      {recent.length > 0 && projectId && (
        <div className="recent">
          <span className="u-title">Neueste Ausgaben</span>
          <div className="recent-grid">
            {recent.map((f) => {
              const url = previewUrl(base, projectId, f.path);
              return (
                <button key={f.path} className="recent-item" onClick={() => open(f)} title={`${f.path} · ${fmtAgo(f.mtime)}`}>
                  {VIDEO.test(f.name) ? <video src={`${url}#t=0.5`} preload="metadata" muted /> : <img src={url} alt="" loading="lazy" />}
                  {VIDEO.test(f.name) && <span className="badge">VIDEO</span>}
                  <span>{f.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="files-bar">
        <FolderOpen size={13} />
        <button className="crumb" onClick={() => setPath('')}>Projekt</button>
        {crumbs.map((c, i) => (
          <span key={i}>/ <button className="crumb" onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>
        ))}
        <button className="u-action" style={{ marginLeft: 'auto' }} onClick={load} title="Neu laden"><RefreshCw size={11} /></button>
      </div>
      <div className="files-list">
        {error && <div className="note error" style={{ padding: 8 }}>{error}</div>}
        {path && <button className="file" onClick={() => setPath(crumbs.slice(0, -1).join('/'))}><Folder size={14} /><span className="fname">..</span><span /></button>}
        {entries.map((e) => (
          <button key={e.path} className={`file${preview?.path === e.path ? ' on' : ''}`} onClick={() => open(e)} title={e.path}>
            {iconFor(e)}
            <span className="fname">{e.name}</span>
            <span className="fmeta">{e.dir ? '' : fmtBytes(e.size)}</span>
          </button>
        ))}
        {!entries.length && !error && <div className="faint" style={{ padding: 10, fontSize: 'var(--t-xs)' }}>Leer</div>}
      </div>
    </div>
  );
}
