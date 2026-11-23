import { t } from '../../lib/i18n';
import { Bot, Check, ChevronDown, ChevronRight, CircleAlert, Clapperboard, FilePen, FileText, Globe, ListChecks, Loader2, MessageCircleQuestion, Search, Sparkles, SquareTerminal, Wrench } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useStore } from '../../lib/store';
import type { ResultBlock, ToolItem } from '../../lib/timeline';
import { fmtTokens } from '../../lib/format';
import { ItemRow } from './ItemRow';
import { Markdown } from './Markdown';
import { DiffView } from './DiffView';

const str = (v: unknown, max = 400) => {
  const s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
/** Path relative to the active project folder (case-insensitive for Windows drives). */
const relPath = (p: unknown) => {
  const s = String(p ?? '').replace(/\\/g, '/');
  const dir = (useStore.getState().projects.find((x) => x.id === useStore.getState().activeId)?.dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return dir && s.toLowerCase().startsWith(`${dir.toLowerCase()}/`) ? s.slice(dir.length + 1) : s;
};

function resultText(item: ToolItem) {
  const r = item.result;
  if (!r) return '';
  return r.blocks.filter((b): b is Extract<ResultBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n');
}

function Images({ blocks }: { blocks: ResultBlock[] }) {
  const [big, setBig] = useState<string | null>(null);
  const imgs = blocks.filter((b): b is Extract<ResultBlock, { type: 'image' }> => b.type === 'image');
  if (!imgs.length) return null;
  return (
    <div className="tool-imgs">
      {imgs.map((b, i) => <img key={i} src={b.url} alt="Tool-Ergebnis" loading="lazy" onClick={() => setBig(b.url)} />)}
      {big && <div className="lightbox" onClick={() => setBig(null)}><img src={big} alt="" /></div>}
    </div>
  );
}

function Output({ item, max = 20000 }: { item: ToolItem; max?: number }) {
  const r = item.result;
  if (!r) return null;
  const s = r.structured;
  if (s && (typeof s.stdout === 'string' || typeof s.stderr === 'string')) {
    return (
      <>
        {s.stdout ? <pre className="out-pre">{s.stdout.slice(0, max)}</pre> : null}
        {s.stderr ? <><div className="tool-sec">stderr</div><pre className="out-pre stderr">{s.stderr.slice(0, max)}</pre></> : null}
        {!s.stdout && !s.stderr && <pre className="out-pre faint">{resultText(item) || '(keine Ausgabe)'}</pre>}
        {s.interrupted && <div className="tool-sec err">unterbrochen</div>}
      </>
    );
  }
  const text = resultText(item);
  return (
    <>
      {text && <pre className={`out-pre${r.isError ? ' stderr' : ''}`}>{text.slice(0, max)}</pre>}
      <Images blocks={r.blocks} />
      {r.blocks.filter((b) => b.type === 'other').map((b, i) => <pre key={i} className="out-pre faint">{(b as { json: string }).json.slice(0, 4000)}</pre>)}
    </>
  );
}

interface View { icon: ReactNode; label: string; summary: string; cmd?: boolean; desc?: string; open?: boolean; thumb?: string; body: ReactNode }

function viewFor(item: ToolItem): View {
  const i = item.input ?? {};
  const name = item.name;
  if (name === 'Bash' || name === 'PowerShell') {
    return {
      icon: <SquareTerminal size={14} />, label: name === 'Bash' ? 'Befehl' : 'PowerShell', summary: str(i.command, 300), cmd: true,
      desc: i.run_in_background ? `${i.description ?? ''} · Hintergrund` : i.description,
      open: !!item.result?.isError,
      body: <>{String(i.command ?? '').length > 120 && <><div className="tool-sec">Befehl</div><pre className="out-pre">{i.command}</pre></>}<div className="tool-sec">Ausgabe</div><Output item={item} /></>,
    };
  }
  if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const edits = name === 'MultiEdit' ? i.edits ?? [] : [{ old_string: i.old_string, new_string: i.new_string }];
    return {
      icon: <FilePen size={14} />, label: 'Bearbeitet', summary: relPath(i.file_path ?? i.notebook_path),
      body: <>{edits.map((e: any, k: number) => <DiffView key={k} a={String(e.old_string ?? '')} b={String(e.new_string ?? e.new_source ?? '')} />)}{item.result?.isError && <Output item={item} />}</>,
    };
  }
  if (name === 'Write') {
    const content = String(i.content ?? '');
    return {
      icon: <FilePen size={14} />, label: 'Geschrieben', summary: relPath(i.file_path), desc: `${content.split('\n').length} Zeilen`,
      body: <><pre className="out-pre">{content.slice(0, 12000)}{content.length > 12000 ? '\n…' : ''}</pre>{item.result?.isError && <Output item={item} />}</>,
    };
  }
  if (name === 'Read') {
    return { icon: <FileText size={14} />, label: 'Gelesen', summary: relPath(i.file_path), desc: i.offset ? `ab Zeile ${i.offset}` : undefined, body: <Output item={item} max={8000} /> };
  }
  if (name === 'Glob' || name === 'Grep') {
    return { icon: <Search size={14} />, label: name === 'Grep' ? 'Suche' : 'Dateien', summary: str(i.pattern), desc: i.path ? relPath(i.path) : undefined, body: <Output item={item} /> };
  }
  if (name === 'WebFetch' || name === 'WebSearch') {
    return { icon: <Globe size={14} />, label: name === 'WebFetch' ? 'Web' : 'Websuche', summary: str(i.url ?? i.query), body: <Output item={item} max={8000} /> };
  }
  if (name === 'TodoWrite') {
    const todos: any[] = i.todos ?? [];
    const done = todos.filter((t) => t.status === 'completed').length;
    return {
      icon: <ListChecks size={14} />, label: 'Plan', summary: `${done}/${todos.length} erledigt`, open: true,
      body: <ul className="todo">{todos.map((t, k) => <li key={k} className={t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : ''}>{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'} {t.status === 'in_progress' ? t.activeForm || t.content : t.content}</li>)}</ul>,
    };
  }
  if (name === 'TaskCreate' || name === 'TaskUpdate') {
    return { icon: <ListChecks size={14} />, label: 'Aufgabe', summary: str(i.subject ?? i.taskId), desc: i.status, body: <Output item={item} /> };
  }
  if (name === 'Agent' || name === 'Task') {
    const t = item.task;
    return {
      icon: <Bot size={14} />, label: 'Subagent', summary: str(i.description ?? i.subagent_type),
      desc: [i.subagent_type, t?.usage ? `${t.usage.tool_uses} Tools · ${fmtTokens(t.usage.total_tokens)} Tokens` : null].filter(Boolean).join(' · '),
      body: (
        <>
          <details><summary className="tool-sec" style={{ cursor: 'pointer' }}>Auftrag</summary><pre className="out-pre">{String(i.prompt ?? '')}</pre></details>
          {item.children.length > 0 && <div className="children">{item.children.map((c, k) => <ItemRow key={c.id} item={c} v={c.v} prev={item.children[k - 1]} />)}</div>}
          {item.result && <><div className="tool-sec">Ergebnis</div><div style={{ padding: '4px 12px 10px' }}><Markdown text={resultText(item)} /></div></>}
        </>
      ),
    };
  }
  if (name === 'AskUserQuestion') {
    const qs: any[] = i.questions ?? [];
    return {
      icon: <MessageCircleQuestion size={14} />, label: 'Rückfrage', summary: str(qs[0]?.question), open: true,
      body: <>{qs.map((q, k) => <div key={k} style={{ padding: '6px 12px' }}><b>{q.question}</b><div className="muted">{(q.options ?? []).map((o: any) => o.label).join(' · ')}</div></div>)}{item.result && <><div className="tool-sec">Antwort</div><pre className="out-pre">{resultText(item)}</pre></>}</>,
    };
  }
  if (name === 'ExitPlanMode') {
    return { icon: <ListChecks size={14} />, label: 'Plan', summary: 'Plan zur Freigabe', open: false, body: <div style={{ padding: '8px 12px' }}><Markdown text={String(i.plan ?? resultText(item) ?? '')} /></div> };
  }
  if (name === 'Skill') {
    return { icon: <Sparkles size={14} />, label: 'Skill', summary: str(i.skill ?? i.command ?? i.name), body: <Output item={item} max={6000} /> };
  }
  if (name.startsWith('mcp__playwright__browser_')) return browserView(item, name.slice('mcp__playwright__browser_'.length));
  const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  return {
    icon: <Wrench size={14} />, label: mcp ? `MCP ${mcp[1]}` : name, summary: mcp ? mcp[2] : str(i, 200),
    body: <><div className="tool-sec">Eingabe</div><pre className="out-pre">{JSON.stringify(i, null, 2).slice(0, 8000)}</pre><div className="tool-sec">Ergebnis</div><Output item={item} /></>,
  };
}

const BROWSER_ACTIONS: Record<string, string> = {
  navigate: 'Öffnet', navigate_back: 'Zurück', click: 'Klickt', type: 'Tippt', hover: 'Hover', press_key: 'Taste',
  fill_form: 'Formular', select_option: 'Auswahl', take_screenshot: 'Screenshot', snapshot: 'Seitenstruktur',
  start_video: 'Aufnahme startet', stop_video: 'Aufnahme beendet', video_chapter: 'Kapitel', video_show_actions: 'Aktionen einblenden',
  evaluate: 'JavaScript', wait_for: 'Wartet', tabs: 'Tabs', resize: 'Fenstergröße', close: 'Schließt', pdf_save: 'PDF',
  run_code_unsafe: 'Playwright-Code', file_upload: 'Datei-Upload',
};

function browserView(item: ToolItem, action: string): View {
  const i = item.input ?? {};
  const isVideo = action.includes('video');
  const summary = str(i.url ?? i.element ?? i.text ?? i.key ?? i.title ?? i.filename ?? i.function ?? i.code ?? (i.size ? `${i.size.width}×${i.size.height}` : ''), 200);
  const firstImg = item.result?.blocks.find((b) => b.type === 'image') as { url: string } | undefined;
  return {
    icon: isVideo ? <Clapperboard size={14} /> : <Globe size={14} />,
    label: 'Browser',
    summary: `${t(BROWSER_ACTIONS[action] ?? action)}${summary ? ` · ${summary}` : ''}`,
    body: <Output item={item} max={6000} />,
    thumb: firstImg?.url,
  };
}

export function ToolCard({ item }: { item: ToolItem }) {
  const view = viewFor(item);
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? !!view.open;
  const progress = useStore((s) => s.progress[item.id]);
  const thumb = view.thumb;
  const err = item.result?.isError;
  const state = !item.result
    ? <span className="tool-state"><Loader2 size={12} className="spin" />{progress ? `${Math.round(progress)} s` : ''}</span>
    : err ? <span className="tool-state err"><CircleAlert size={12} /> Fehler</span>
      : item.task?.status === 'running' ? <span className="tool-state"><Loader2 size={12} className="spin" /></span>
        : <span className="tool-state ok"><Check size={12} /></span>;
  return (
    <div className={`tool${err ? ' error' : ''}`}>
      <div className="tool-head" onClick={() => setOpen(!isOpen)} role="button" tabIndex={0} aria-expanded={isOpen}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!isOpen); } }}>
        <span className="tool-icon">{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        <span className="tool-icon">{view.icon}</span>
        <span className="tool-name">{view.label}</span>
        <span className={`tool-summary${view.cmd ? ' cmd' : ''}`} title={view.summary}>{view.summary}</span>
        {view.desc && <span className="tool-desc" title={view.desc}>{view.desc}</span>}
        {thumb && <img className="thumb" src={thumb} alt="" />}
        {state}
      </div>
      {isOpen && <div className="tool-body">{view.body}</div>}
    </div>
  );
}
