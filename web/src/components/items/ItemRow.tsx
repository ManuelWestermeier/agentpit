import { memo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { fmtClock, fmtDuration, fmtTokens, fmtUsd, shortModel } from '../../lib/format';
import { t } from '../../lib/i18n';
import { act, useStore } from '../../lib/store';
import type { Item } from '../../lib/timeline';
import { conn } from '../../lib/ws';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';

const DECISION: Record<string, string> = { allow: 'erlaubt', always: 'dauerhaft erlaubt', deny: 'abgelehnt' };

export const ItemRow = memo(function ItemRow({ item }: { item: Item; v: number; prev?: Item }) {
  const gutterTime = item.kind === 'user';
  return (
    <div className={`row row--${item.kind}`}>
      <div className="gutter">{gutterTime && fmtClock(item.ts)}</div>
      <div className="cell"><ItemBody item={item} /></div>
    </div>
  );
}, (a, b) => a.item === b.item && a.v === b.v && a.prev?.kind === b.prev?.kind);

export function ItemBody({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user': return <UserPrompt text={item.text} uuid={item.uuid} queued={item.queued} />;
    case 'assistant': return <Markdown text={item.text} />;
    case 'thinking': return <Thinking text={item.text} />;
    case 'tool': return <ToolCard item={item} />;
    case 'output': return <div className={`output${item.error ? ' error' : ''}`}><Markdown text={item.text} /></div>;
    case 'note': return <Note level={item.level} text={item.text} detail={item.detail} />;
    case 'turn':
      return (
        <div className={`turn${item.ok ? '' : ' fail'}`}>
          {!item.ok && <b>{item.subtype === 'error_max_turns' ? 'Turn-Limit erreicht' : item.subtype === 'error_max_budget_usd' ? 'Budget erreicht' : 'Abgebrochen'}</b>}
          <span className="tab-nums">{fmtDuration(item.ms)}{item.cost ? ` · ${fmtUsd(item.cost)}` : ''}</span>
          {item.errors?.length ? <span className="err">{item.errors.join('; ').slice(0, 200)}</span> : null}
        </div>
      );
    case 'compact':
      return <div className="compact">Kontext komprimiert ({item.trigger === 'auto' ? 'automatisch' : 'manuell'}) · {fmtTokens(item.pre)}{item.post ? ` → ${fmtTokens(item.post)}` : ''} Tokens</div>;
    case 'perm':
      return (
        <div className={`note ${item.decision === 'deny' ? 'warn' : 'dim'}`}>
          Freigabe {item.toolName}: {DECISION[item.decision] ?? item.decision}
          {item.message && item.decision === 'deny' ? ` – „${item.message}“` : ''}
          {item.answers ? ` – ${Object.values(item.answers).join(' · ')}` : ''}
        </div>
      );
    case 'init': {
      // model and tool count are visible elsewhere; only a tool server that failed to connect matters here
      // plugins and claude.ai connectors come from the user's global Claude setup – not logged in there is normal, not a fault here
      const broken = item.mcp.filter((m) => m.status === 'failed' && !/^(plugin:|claude\.ai )/.test(m.name));
      if (!broken.length) return null;
      return <div className="note warn">{broken.map((m) => `${m.name}: ${m.status}`).join(' · ')} – diese Werkzeuge fehlen in der Session ({shortModel(item.model)})</div>;
    }
    default:
      return null;
  }
}

function UserPrompt({ text, uuid, queued }: { text: string; uuid?: string; queued?: boolean }) {
  const isCmd = /^\/[\w:-]+/.test(text);
  const projectId = useStore((s) => s.activeId);
  const live = useStore((s) => (s.activeId ? s.runners[s.activeId]?.live : false));
  const rewind = async () => {
    if (!projectId || !uuid) return;
    const dry = await act(() => conn.call<{ canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }>('rewind', { projectId, userMessageId: uuid, dryRun: true }));
    if (!dry) return;
    if (!dry.canRewind) { useStore.getState().toast('warn', dry.error ?? 'Für diesen Prompt gibt es keinen Dateistand.'); return; }
    const files = dry.filesChanged ?? [];
    if (!files.length) { useStore.getState().toast('info', 'Seit diesem Prompt wurden keine Dateien über Edit/Write geändert.'); return; }
    const ok = window.confirm(`${t('Dateien auf den Stand vor diesem Prompt zurücksetzen?')}\n\n${files.slice(0, 15).join('\n')}${files.length > 15 ? `\n${t(`… und ${files.length - 15} weitere`)}` : ''}\n\n${t(`+${dry.insertions ?? 0} / −${dry.deletions ?? 0} Zeilen. Änderungen per Bash werden nicht erfasst.`)}`);
    if (ok) await act(() => conn.call('rewind', { projectId, userMessageId: uuid, dryRun: false }), 'Dateien zurückgesetzt');
  };
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
      <div className={`user-text${isCmd ? ' command' : ''}`} style={{ flex: 1 }}>
        {text}
        {queued && <span className="queued">in Warteschlange</span>}
      </div>
      {uuid && live && !isCmd && (
        <button className="btn ghost icon small" title="Dateien auf den Stand vor diesem Prompt zurücksetzen" onClick={rewind}>
          <RotateCcw size={12} />
        </button>
      )}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <details className="thinking" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Gedankengang</summary>
      {open && <pre>{text}</pre>}
    </details>
  );
}

function Note({ level, text, detail }: { level: string; text: string; detail?: string }) {
  if (!detail) return <div className={`note ${level}`}>{text}</div>;
  return (
    <div className={`note ${level}`}>
      <details style={{ minWidth: 0, flex: 1 }}>
        <summary>{text}</summary>
        <pre>{detail}</pre>
      </details>
    </div>
  );
}
