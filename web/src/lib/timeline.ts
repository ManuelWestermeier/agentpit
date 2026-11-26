// Turns logged SDK messages (+ cockpit events) into display items.
// The same builder handles history replay and live events.

export type ResultBlock = { type: 'text'; text: string } | { type: 'image'; url: string } | { type: 'other'; json: string };

export interface ToolResult {
  blocks: ResultBlock[];
  isError: boolean;
  structured?: any;
}

interface Base { id: string; v: number; ts: number; parent?: string | null }

export interface UserItem extends Base { kind: 'user'; text: string; uuid?: string; queued?: boolean }
export interface TextItem extends Base { kind: 'assistant'; text: string }
export interface ThinkingItem extends Base { kind: 'thinking'; text: string }
export interface ToolItem extends Base {
  kind: 'tool';
  name: string;
  input: any;
  result?: ToolResult;
  children: Item[];
  task?: { status?: string; description?: string; summary?: string; usage?: { total_tokens: number; tool_uses: number; duration_ms: number } };
}
export interface NoteItem extends Base { kind: 'note'; level: 'dim' | 'info' | 'warn' | 'error'; text: string; detail?: string }
export interface OutputItem extends Base { kind: 'output'; text: string; error?: boolean }
export interface TurnItem extends Base { kind: 'turn'; ok: boolean; ms: number; cost: number | null; calls: number | null; subtype: string; errors?: string[] }
export interface CompactItem extends Base { kind: 'compact'; trigger: string; pre: number; post?: number }
export interface PermItem extends Base { kind: 'perm'; toolName: string; decision: string; message?: string | null; answers?: Record<string, string> | null }
export interface InitItem extends Base { kind: 'init'; model: string; tools: number; mcp: { name: string; status: string }[]; version?: string; mode?: string }

export interface DeniedItem extends Base { kind: 'denied'; mode: string; tools: { name: string; detail?: string }[] }
export type Item = DeniedItem | UserItem | TextItem | ThinkingItem | ToolItem | NoteItem | OutputItem | TurnItem | CompactItem | PermItem | InitItem;

const COMMAND_RE = /<command-name>\s*([^<]+?)\s*<\/command-name>(?:[\s\S]*?<command-args>([\s\S]*?)<\/command-args>)?/;
const LOCAL_OUT_RE = /<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/;

function blocksOf(content: any): ResultBlock[] {
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'other', json: JSON.stringify(content, null, 2) }];
  const out: ResultBlock[] = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text });
    else if (b.type === 'image') {
      const url = b.source?.url ?? (b.source?.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : null);
      if (url) out.push({ type: 'image', url });
    } else out.push({ type: 'other', json: JSON.stringify(b, null, 2) });
  }
  return out;
}

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  return '';
}

export class Timeline {
  items: Item[] = [];
  private tools = new Map<string, ToolItem>();
  private n = 0;
  private lastInitModel: string | null = null;
  version = 0;

  constructor(public source: 'cockpit' | 'transcript' | 'none' = 'cockpit') {}

  private nid(prefix: string) { return `${prefix}-${++this.n}`; }

  private push(item: Item) {
    const parentId = item.parent;
    const parent = parentId ? this.tools.get(parentId) : undefined;
    if (parent) {
      parent.children.push(item);
      this.bump(parent);
    } else {
      this.items.push(item);
    }
    if (item.kind === 'tool') this.tools.set(item.id, item);
  }

  /** Increment versions up to the root so memoized rows re-render. */
  private bump(item: Item) {
    let cur: Item | undefined = item;
    let guard = 0;
    while (cur && guard++ < 20) {
      cur.v++;
      cur = cur.parent ? this.tools.get(cur.parent) : undefined;
    }
  }

  ingestAll(events: any[]) {
    for (const ev of events) this.ingest(ev, false);
    this.version++;
  }

  ingest(ev: any, bumpVersion = true) {
    try { this.handle(ev); } catch (e) { console.warn('timeline', e, ev); }
    if (bumpVersion) this.version++;
  }

  markCommand(uuid: string, state: string) {
    for (let i = this.items.length - 1; i >= 0 && i >= this.items.length - 60; i--) {
      const it = this.items[i];
      if (it.kind === 'user' && it.uuid === uuid) {
        const queued = state === 'queued';
        if (it.queued !== queued) { it.queued = queued; it.v++; this.version++; }
        return;
      }
    }
  }

  private handle(ev: any) {
    const ts = ev._ts ?? (ev.timestamp ? Date.parse(ev.timestamp) : Date.now());
    switch (ev.type) {
      case 'cockpit': return this.cockpit(ev, ts);
      case 'assistant': return this.assistant(ev, ts);
      case 'user': return this.user(ev, ts);
      case 'result': return this.result(ev, ts);
      case 'system': return this.system(ev, ts);
      case 'rate_limit_event': {
        const i = ev.rate_limit_info ?? {};
        if (i.status && i.status !== 'allowed') {
          this.push({ kind: 'note', id: this.nid('rl'), v: 0, ts, level: i.status === 'rejected' ? 'error' : 'warn',
            text: i.status === 'rejected' ? 'Nutzungslimit erreicht – Claude pausiert bis zum Reset.' : 'Nutzungslimit fast erreicht.' });
        }
        return;
      }
      case 'conversation_reset':
        return;
      default:
        return;
    }
  }

  private cockpit(ev: any, ts: number) {
    switch (ev.subtype) {
      case 'user_prompt':
        this.push({ kind: 'user', id: ev.uuid ?? this.nid('u'), v: 0, ts, text: ev.text ?? '', uuid: ev.uuid, queued: !!ev.queued });
        return;
      case 'permission_decision':
        this.push({ kind: 'perm', id: this.nid('p'), v: 0, ts, toolName: ev.toolName, decision: ev.decision, message: ev.message, answers: ev.answers });
        return;
      case 'runner_started':
        // process start/resume is routine – only a fork changes what the history means
        if (ev.forkedFrom) this.push({ kind: 'note', id: this.nid('n'), v: 0, ts, level: 'dim', text: 'Abgezweigt aus einer früheren Session' });
        return;
      case 'runner_stopped':
        // idle timeout, switching sessions, restarts: routine, the next prompt continues seamlessly
        return;
      case 'error':
        this.push({ kind: 'note', id: this.nid('e'), v: 0, ts, level: 'error', text: 'Claude Code ist abgestürzt', detail: ev.text });
        return;
      case 'limit':
        this.push({ kind: 'note', id: this.nid('n'), v: 0, ts, level: 'warn', text: ev.text });
        return;
      case 'context_saved':
        this.push({ kind: 'note', id: this.nid('n'), v: 0, ts, level: 'dim', text: ev.text });
        return;
      case 'setting': {
        const label: Record<string, string> = { model: 'Modell', mode: 'Modus', effort: 'Effort' };
        this.push({ kind: 'note', id: this.nid('n'), v: 0, ts, level: 'dim', text: `${label[ev.key] ?? ev.key} → ${ev.value}` });
        return;
      }
      case 'session_reset':
        this.push({ kind: 'note', id: this.nid('n'), v: 0, ts, level: 'info', text: 'Neue Unterhaltung (/clear) – Kontext geleert' });
        return;
      case 'rewind':
        this.push({ kind: 'note', id: this.nid('n'), v: 0, ts, level: 'info', text: `Dateien zurückgesetzt (${(ev.files ?? []).length})`, detail: (ev.files ?? []).join('\n') });
        return;
      case 'git_commit':
        this.push({ kind: 'note', id: this.nid('n'), v: 0, ts, level: 'dim', text: `Commit ${ev.hash} · ${ev.subject}` });
        return;
      case 'permission_denied':
        this.push({ kind: 'denied', id: this.nid('d'), v: 0, ts, mode: ev.mode ?? '', tools: ev.tools ?? [] });
        return;
      case 'error_note':
        this.push({ kind: 'note', id: this.nid('e'), v: 0, ts, level: 'warn', text: ev.text });
        return;
      case 'fork_marker':
        this.push({ kind: 'note', id: this.nid('n'), v: 0, ts, level: 'info', text: 'Ab hier: abgezweigte Session' });
        return;
      default:
        return;
    }
  }

  private assistant(ev: any, ts: number) {
    const m = ev.message;
    if (!m) return;
    const parent = ev.parent_tool_use_id ?? null;
    if (m.model === '<synthetic>') {
      const text = textOf(m.content);
      if (text) this.push({ kind: 'output', id: this.nid('o'), v: 0, ts, text, error: !!ev.error, parent });
      return;
    }
    const content = Array.isArray(m.content) ? m.content : [];
    content.forEach((b: any, i: number) => {
      if (!b) return;
      const id = `${m.id ?? ev.uuid}:${i}:${b.type}`;
      if (b.type === 'text' && b.text?.trim()) this.push({ kind: 'assistant', id: `${id}:${this.n++}`, v: 0, ts, text: b.text, parent });
      else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        this.push({ kind: 'thinking', id: `${id}:${this.n++}`, v: 0, ts, text: b.thinking ?? '', parent });
      } else if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
        if (this.tools.has(b.id)) return;
        this.push({ kind: 'tool', id: b.id, v: 0, ts, name: b.name, input: b.input ?? {}, children: [], parent });
      } else if (b.type?.endsWith('_tool_result') && b.tool_use_id) {
        this.attachResult(b.tool_use_id, { blocks: blocksOf(b.content), isError: !!b.is_error });
      }
    });
  }

  private attachResult(toolUseId: string, result: ToolResult) {
    const tool = this.tools.get(toolUseId);
    if (!tool) return false;
    tool.result = result;
    this.bump(tool);
    return true;
  }

  private user(ev: any, ts: number) {
    const m = ev.message;
    if (!m) return;
    const content = m.content;
    const parent = ev.parent_tool_use_id ?? null;
    if (Array.isArray(content)) {
      let textParts: string[] = [];
      for (const b of content) {
        if (b?.type === 'tool_result') {
          this.attachResult(b.tool_use_id, { blocks: blocksOf(b.content), isError: !!b.is_error, structured: ev.tool_use_result });
        } else if (b?.type === 'text') textParts.push(b.text);
      }
      if (textParts.length) this.userText(textParts.join('\n'), ev, ts, parent);
      return;
    }
    if (typeof content === 'string') this.userText(content, ev, ts, parent);
  }

  private userText(text: string, ev: any, ts: number, parent: string | null) {
    const t = text.trim();
    if (!t) return;
    const cmd = t.match(COMMAND_RE);
    if (cmd) {
      if (this.source === 'transcript') {
        const args = cmd[2]?.trim();
        this.push({ kind: 'user', id: ev.uuid ?? this.nid('u'), v: 0, ts, text: args ? `${cmd[1]} ${args}` : cmd[1] });
      }
      return;
    }
    const out = t.match(LOCAL_OUT_RE);
    if (out) {
      if (out[1].trim()) this.push({ kind: 'output', id: this.nid('o'), v: 0, ts, text: out[1].trim(), parent });
      return;
    }
    if (/^This session is being continued from a previous conversation/i.test(t) || ev.isCompactSummary) {
      this.push({ kind: 'note', id: this.nid('n'), v: 0, ts, level: 'info', text: 'Zusammenfassung nach Compact', detail: t });
      return;
    }
    if (/^\[Request interrupted by user/.test(t)) {
      this.push({ kind: 'note', id: this.nid('n'), v: 0, ts, level: 'warn', text: 'Vom Nutzer unterbrochen', parent });
      return;
    }
    // Subagent prompts, skill bodies, system reminders: context, not something the user typed
    const humanTyped = this.source === 'transcript' && !ev.isSynthetic && !ev.isMeta && !parent && !t.startsWith('<');
    if (humanTyped) this.push({ kind: 'user', id: ev.uuid ?? this.nid('u'), v: 0, ts, text: t });
    else this.push({ kind: 'note', id: this.nid('n'), v: 0, ts, level: 'dim', text: parent ? 'Auftrag an Subagent' : 'Kontext eingefügt', detail: t, parent });
  }

  private result(ev: any, ts: number) {
    if (ev.local_command && !ev.is_error) return; // /context, /usage … already shown as output
    this.push({
      kind: 'turn', id: ev.uuid ?? this.nid('r'), v: 0, ts,
      ok: ev.subtype === 'success' && !ev.is_error,
      ms: ev.duration_ms ?? 0,
      cost: ev._cockpit?.costDelta ?? null,
      calls: ev._cockpit?.calls ?? null,
      subtype: ev.subtype,
      errors: ev.errors,
    });
  }

  private system(ev: any, ts: number) {
    switch (ev.subtype) {
      case 'init': {
        if (this.lastInitModel === ev.model) return;
        this.lastInitModel = ev.model;
        this.push({ kind: 'init', id: ev.uuid ?? this.nid('i'), v: 0, ts, model: ev.model, tools: (ev.tools ?? []).length, mcp: ev.mcp_servers ?? [], version: ev.claude_code_version, mode: ev.permissionMode });
        return;
      }
      case 'compact_boundary':
        this.push({ kind: 'compact', id: ev.uuid ?? this.nid('c'), v: 0, ts, trigger: ev.compact_metadata?.trigger ?? 'manual', pre: ev.compact_metadata?.pre_tokens ?? 0, post: ev.compact_metadata?.post_tokens });
        return;
      case 'status':
        if (ev.compact_result === 'failed') this.push({ kind: 'note', id: this.nid('n'), v: 0, ts, level: 'error', text: `Compact fehlgeschlagen${ev.compact_error ? `: ${ev.compact_error}` : ''}` });
        return;
      case 'api_retry':
        this.push({ kind: 'note', id: this.nid('n'), v: 0, ts, level: 'warn', text: `API-Fehler ${ev.error_status ?? ''} (${ev.error}) – Versuch ${ev.attempt}/${ev.max_retries} in ${Math.round((ev.retry_delay_ms ?? 0) / 1000)} s` });
        return;
      case 'informational':
      case 'notification': {
        const text = ev.content ?? ev.text;
        if (!text) return;
        const level = ev.level === 'warning' || ev.priority === 'high' || ev.priority === 'immediate' ? 'warn' : ev.level === 'info' ? 'dim' : 'info';
        this.push({ kind: 'note', id: ev.uuid ?? this.nid('n'), v: 0, ts, level, text });
        return;
      }
      case 'permission_denied':
        this.push({ kind: 'note', id: this.nid('n'), v: 0, ts, level: 'warn', text: `Abgelehnt: ${ev.tool_name}`, detail: ev.message });
        return;
      case 'local_command_output':
        if (ev.content) this.push({ kind: 'output', id: this.nid('o'), v: 0, ts, text: ev.content });
        return;
      case 'task_started':
      case 'task_notification': {
        const tool = ev.tool_use_id ? this.tools.get(ev.tool_use_id) : undefined;
        if (tool) {
          tool.task = { ...tool.task, status: ev.status ?? 'running', description: ev.description ?? tool.task?.description, summary: ev.summary ?? tool.task?.summary, usage: ev.usage ?? tool.task?.usage };
          this.bump(tool);
        } else if (ev.subtype === 'task_notification' && ev.summary) {
          this.push({ kind: 'note', id: this.nid('n'), v: 0, ts, level: ev.status === 'failed' ? 'error' : 'info', text: `Hintergrund-Task ${ev.status === 'completed' ? 'fertig' : ev.status}: ${ev.summary}` });
        }
        return;
      }
      default:
        return;
    }
  }
}
