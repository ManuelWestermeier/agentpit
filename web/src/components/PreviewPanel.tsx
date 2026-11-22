import { ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { previewUrl } from '../lib/hooks';
import { useStore } from '../lib/store';
import { Markdown } from './items/Markdown';

const KIND: [RegExp, 'video' | 'image' | 'audio' | 'pdf' | 'html' | 'md' | 'text'][] = [
  [/\.(mp4|webm|mov|m4v|mkv|ogv)$/i, 'video'],
  [/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i, 'image'],
  [/\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i, 'audio'],
  [/\.pdf$/i, 'pdf'],
  [/\.html?$/i, 'html'],
  [/\.(md|markdown)$/i, 'md'],
  [/\.(txt|log|json|jsonl|js|mjs|cjs|ts|tsx|jsx|css|scss|py|sh|ps1|bat|cmd|yml|yaml|toml|ini|env|csv|tsv|xml|srt|vtt|ass|kt|java|c|cpp|h|rs|go|sql|gitignore)$/i, 'text'],
];
const kindOf = (p: string) => KIND.find(([re]) => re.test(p))?.[1] ?? 'text';
const MAX_TEXT = 512 * 1024;

export function PreviewPanel() {
  const projectId = useStore((s) => s.activeId);
  const preview = useStore((s) => s.preview);
  const version = useStore((s) => s.filesVersion);
  const base = useStore((s) => s.hello?.config.previewBase ?? '');
  const [text, setText] = useState<string | null>(null);
  const [bust, setBust] = useState(0);
  const kind = preview ? kindOf(preview.path) : null;
  const url = preview && projectId ? `${previewUrl(base, projectId, preview.path)}?v=${preview.at + bust}` : '';

  useEffect(() => {
    setText(null);
    if (!url || (kind !== 'text' && kind !== 'md')) return;
    const ctl = new AbortController();
    fetch(url, { signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        const len = Number(r.headers.get('content-length') ?? 0);
        if (len > MAX_TEXT) return `Datei ist ${Math.round(len / 1024)} KB groß – öffne sie extern.`;
        return r.text();
      })
      .then(setText)
      .catch((e) => { if (e.name !== 'AbortError') setText(`Konnte nicht geladen werden (${e.message}).`); });
    return () => ctl.abort();
  }, [url, kind]);

  // Text files follow changes on disk; media keeps playing until "neu laden"
  useEffect(() => { if (kind === 'text' || kind === 'md') setBust((b) => b + 1); }, [version, kind]);

  if (!preview || !projectId) return <div className="empty" />;
  return (
    <div className="preview">
      <div className="preview-bar">
        <span className="pname" title={preview.path}>{preview.path}</span>
        <button className="u-action" onClick={() => setBust((b) => b + 1)} title="Neu laden"><RefreshCw size={11} /></button>
        <a className="u-action" href={url} target="_blank" rel="noreferrer" title="In neuem Tab öffnen"><ExternalLink size={11} /></a>
      </div>
      <div className="preview-body">
        {kind === 'video' && <video key={url} src={url} controls autoPlay={false} preload="metadata" />}
        {kind === 'image' && <img key={url} src={url} alt={preview.path} />}
        {kind === 'audio' && <audio key={url} src={url} controls />}
        {(kind === 'pdf' || kind === 'html') && (
          <iframe key={url} src={url} title={preview.path}
            sandbox={kind === 'html' ? 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals' : undefined} />
        )}
        {kind === 'md' && (text == null ? <pre className="faint">lädt …</pre> : <Markdown text={text} />)}
        {kind === 'text' && <pre>{text ?? 'lädt …'}</pre>}
      </div>
    </div>
  );
}
