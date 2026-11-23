import { ArrowDown, ChartColumn, Code, Loader2, Mail, Newspaper, Radar, Workflow } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fmtDuration } from '../lib/format';
import { useActive, useNow } from '../lib/hooks';
import { useStore, type Filter } from '../lib/store';
import type { Item, ToolItem } from '../lib/timeline';
import { TEMPLATES } from '../lib/templates';
import { ItemRow } from './items/ItemRow';
import { Markdown } from './items/Markdown';

const CMD_TOOLS = new Set(['Bash', 'PowerShell']);
const PAGE = 250;

function flattenCommands(items: Item[], out: Item[] = []) {
  for (const it of items) {
    if (it.kind === 'user') out.push(it);
    else if (it.kind === 'tool') {
      if (CMD_TOOLS.has(it.name)) out.push(it);
      if (it.children.length) flattenCommands(it.children, out);
    }
  }
  return out;
}

function applyFilter(items: Item[], f: Filter) {
  if (f === 'all') return items;
  if (f === 'commands') return flattenCommands(items);
  return items.filter((i) => i.kind === 'user' || i.kind === 'assistant' || i.kind === 'output' || i.kind === 'turn' || (i.kind === 'note' && i.level !== 'dim'));
}

export function TimelineView({ extra }: { extra?: ReactNode } = {}) {
  const view = useStore((s) => s.view);
  const version = useStore((s) => s.view?.version ?? 0);
  const filter = useStore((s) => s.filter);
  const live = useStore((s) => s.live);
  const { runner } = useActive();
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [limit, setLimit] = useState(PAGE);

  const items = view?.timeline.items ?? [];
  const filtered = useMemo(() => applyFilter(items, filter), [version, filter, view?.timeline]);
  const shown = filtered.length > limit ? filtered.slice(-limit) : filtered;
  const isLiveView = !!view?.follow && runner?.sessionId === view?.sessionId;
  const busy = isLiveView && (runner?.state === 'running' || runner?.state === 'starting');

  useEffect(() => { setLimit(PAGE); setStick(true); }, [view?.sessionId, view?.projectId]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [version, live.text, live.thinking, stick, shown.length, busy]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (near !== stick) setStick(near);
  };

  if (!view) return <div className="timeline-wrap" />;

  return (
    <div className="timeline-wrap">
      {(items.length > 0 || extra) && <Filters extra={extra} />}
      <div className="timeline" ref={ref} onScroll={onScroll}>
        {view.loading && <div className="note dim" style={{ paddingLeft: 'calc(var(--gutter) + 12px)' }}><Loader2 size={12} className="spin" /> Lade Verlauf …</div>}
        {(filtered.length > limit || view.truncated) && (
          <button className="btn small load-more" onClick={() => setLimit((l) => l + PAGE)} disabled={filtered.length <= limit}>
            {filtered.length > limit ? `${filtered.length - limit} ältere Einträge anzeigen` : `Älteste ${view.total - items.length} Ereignisse nicht geladen (HISTORY_LIMIT)`}
          </button>
        )}
        {!view.loading && !items.length && <EmptyState />}
        {shown.map((it, i) => <ItemRow key={it.id} item={it} v={it.v} prev={shown[i - 1]} />)}
        {isLiveView && (live.thinking || live.text) && (
          <div className="row">
            <div className="gutter" />
            <div className="cell">
              {live.thinking && !live.text && <div className="thinking"><span className="faint">denkt nach …</span> <span className="muted">{live.thinking.slice(-160)}</span></div>}
              {live.text && <div className="live-text caret"><Markdown text={live.text} /></div>}
            </div>
          </div>
        )}
        {busy && <Working />}
      </div>
      {!stick && (
        <button className="btn small jump" onClick={() => { setStick(true); const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }}>
          <ArrowDown size={13} /> Neueste
        </button>
      )}
    </div>
  );
}

function Filters({ extra }: { extra?: ReactNode }) {
  const filter = useStore((s) => s.filter);
  const set = (f: Filter) => useStore.setState({ filter: f });
  const opts: [Filter, string][] = [['all', 'Alles'], ['chat', 'Nur Dialog'], ['commands', 'Befehle & Ausgaben']];
  return (
    <div className="filters" role="tablist" aria-label="Filter">
      {opts.map(([k, l]) => (
        <button key={k} className={`chip${filter === k ? ' active' : ''}`} onClick={() => set(k)} role="tab" aria-selected={filter === k}>{l}</button>
      ))}
      {extra && <span style={{ marginLeft: 'auto' }} />}
      {extra}
    </div>
  );
}

function Working() {
  const { runner } = useActive();
  const now = useNow(1000);
  const t = runner?.turn;
  const lastTool = useStore((s) => {
    const items = s.view?.timeline.items ?? [];
    for (let i = items.length - 1; i >= Math.max(0, items.length - 8); i--) {
      const it = items[i];
      if (it.kind === 'tool' && !it.result) return it as ToolItem;
      if (it.kind === 'user') break;
    }
    return null;
  });
  const progress = useStore((s) => (lastTool ? s.progress[lastTool.id] : undefined));
  return (
    <div className="row">
      <div className="gutter" />
      <div className="cell note" style={{ color: 'var(--amber)' }}>
        <Loader2 size={13} className="spin" />
        <span className="tab-nums">
          {runner?.compacting ? 'komprimiert Kontext' : runner?.state === 'starting' ? 'startet Claude Code' : lastTool ? `${lastTool.name} läuft${progress ? ` seit ${Math.round(progress)} s` : ''}` : 'arbeitet'}
          {t ? ` · ${fmtDuration(now - t.startedAt)}` : ''}
        </span>
      </div>
    </div>
  );
}

const TEMPLATE_ICON: Record<string, ReactNode> = {
  radar: <Radar size={15} />, workflow: <Workflow size={15} />, newspaper: <Newspaper size={15} />,
  chart: <ChartColumn size={15} />, code: <Code size={15} />, mail: <Mail size={15} />,
};

/** Empty session: ready-made tasks – a click puts the prompt into the composer and selects the first «…» to fill in. */
function EmptyState() {
  const { project } = useActive();
  const use = (prompt: string) => {
    if (!project) return;
    useStore.setState((s) => ({ draft: { ...s.draft, [project.id]: prompt } }));
    requestAnimationFrame(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.composer-box textarea');
      if (!ta) return;
      ta.focus();
      const a = prompt.indexOf('«'), b = prompt.indexOf('»', a);
      if (a >= 0 && b > a) ta.setSelectionRange(a, b + 1);
    });
  };
  return (
    <div className="empty templates-empty">
      <div className="templates" data-i18n-skip>
        {TEMPLATES.map((t) => (
          <button key={t.id} className="template" onClick={() => use(t.prompt)} title={t.prompt}>
            <span className="template-icon">{TEMPLATE_ICON[t.icon]}</span>
            <span className="template-title">{t.title}</span>
            <span className="template-desc">{t.desc}</span>
          </button>
        ))}
      </div>
      <p className="faint">Ergebnisse landen in <code title={project?.dir}>output/</code>.</p>
    </div>
  );
}
