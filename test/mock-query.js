// Development harness: a scripted stand-in for the Agent SDK's query() so the UI can be
// exercised without a Claude login. Start with:  COCKPIT_MOCK=1 npm start
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT = () => fs.readFileSync(path.join(FIX, 'screenshot.png')).toString('base64');

const MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (empfohlen)', description: 'Opus 5.5 · $4/$20 per Mtok', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAutoMode: true },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · $4/$20 per Mtok', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAutoMode: true },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5 · $2/$10 per Mtok', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], supportsAutoMode: true },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', description: 'Haiku 5.5 · $0.8/$4 per Mtok', supportsEffort: false, supportedEffortLevels: [], supportsAutoMode: false },
];
const COMMANDS = ['compact', 'clear', 'context', 'usage', 'init', 'code-review', 'security-review', 'model', 'mcp', 'video', 'browser']
  .map((name) => ({ name, description: `Befehl ${name}`, argumentHint: '', builtin: !['video', 'browser'].includes(name) }));

let usageCalls = 0;
const fiveReset = Date.now() + (2 * 60 + 13) * 60_000;

export function installMock(ctx) {
  ctx.query = mockQuery;
  ctx.auth.refresh = async function refresh() {
    this.status = { loggedIn: true, authMethod: 'claude.ai', email: 'demo@example.de', apiProvider: 'firstParty' };
    this.emit('change');
    return this.status;
  };
}

function mockQuery({ prompt, options }) {
  const sessionId = options.sessionId ?? options.resume ?? randomUUID();
  const out = [];
  let wake = null;
  let closed = false;
  let interrupted = false;
  let totalCost = 0;
  let ctxTokens = 38_400;
  const modelUsage = {};
  const emit = (m) => { out.push({ uuid: randomUUID(), session_id: sessionId, ...m }); wake?.(); };

  const addUsage = (inT, outT, cr, cw) => {
    const mu = modelUsage['claude-opus-5-5'] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreationEphemeral5mInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 1_000_000, maxOutputTokens: 64_000, canonicalModel: 'claude-opus-5-5' };
    const cost = (inT * 4 + outT * 20 + cr * 0.4 + cw * 5) / 1e6;
    mu.inputTokens += inT; mu.outputTokens += outT; mu.cacheReadInputTokens += cr; mu.cacheCreationInputTokens += cw; mu.cacheCreationEphemeral5mInputTokens += cw; mu.costUSD += cost;
    totalCost += cost;
    ctxTokens += inT + cw + outT;
  };

  const assistant = (content, outT = 220) => {
    const id = `msg_${randomUUID().slice(0, 8)}`;
    addUsage(12, outT, ctxTokens - 4000, 4000);
    for (const block of content) {
      emit({ type: 'assistant', parent_tool_use_id: null, message: { id, model: 'claude-opus-5-5', role: 'assistant', type: 'message', content: [block], usage: { input_tokens: 12, output_tokens: outT, cache_read_input_tokens: ctxTokens - 4000, cache_creation_input_tokens: 4000, cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 0 } } } });
    }
  };
  const toolResult = (id, content, extra = {}) => emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: !!extra.isError }] }, tool_use_result: extra.structured });

  async function stream(text) {
    emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } });
    for (const chunk of text.match(/.{1,14}/gs) ?? []) {
      if (interrupted) return;
      emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } });
      await sleep(45);
    }
    emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } });
    assistant([{ type: 'text', text }]);
  }

  async function ask(toolName, input, extra = {}) {
    const ac = new AbortController();
    return options.canUseTool(toolName, input, { signal: ac.signal, toolUseID: input.__id, requestId: randomUUID(), suggestions: extra.suggestions ?? [], title: extra.title, displayName: extra.displayName });
  }

  async function turn(text) {
    const started = Date.now();
    interrupted = false;
    emit({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', permissionMode: options.permissionMode, cwd: options.cwd, tools: ['Agent', 'Bash', 'Edit', 'Read', 'Write', 'WebFetch', 'TodoWrite', 'AskUserQuestion', 'mcp__playwright__browser_navigate'], mcp_servers: [{ name: 'playwright', status: 'connected' }], slash_commands: COMMANDS.map((c) => c.name), claude_code_version: '2.1.330-mock', apiKeySource: 'none', output_style: 'default', skills: ['video', 'browser'], plugins: [] });
    emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });

    if (text.startsWith('/context')) {
      emit({ type: 'assistant', parent_tool_use_id: null, message: { id: randomUUID(), model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: `## Context Usage\n\n**Tokens:** ${Math.round(ctxTokens / 1000)}k / 1m\n\n| Kategorie | Tokens |\n|---|---|\n| System prompt | 2.1k |\n| System tools | 17.7k |\n| Messages | ${Math.round((ctxTokens - 20000) / 1000)}k |` }], usage: {} } });
      emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 40, duration_api_ms: 0, num_turns: 0, result: '', total_cost_usd: totalCost, usage: {}, modelUsage, permission_denials: [], local_command: 'context' });
      emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
      return;
    }
    if (text.startsWith('/compact')) {
      emit({ type: 'system', subtype: 'status', status: 'compacting' });
      await sleep(1500);
      const pre = ctxTokens;
      ctxTokens = Math.round(ctxTokens * 0.35);
      emit({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
      emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: pre, post_tokens: ctxTokens } });
      emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1500, duration_api_ms: 1400, num_turns: 1, result: '', total_cost_usd: totalCost, usage: {}, modelUsage, permission_denials: [] });
      emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
      return;
    }

    await stream('Ich prüfe zuerst die Werkzeuge, öffne dann die Seite im Browser und baue daraus ein kurzes Video. Den Plan halte ich als Aufgabenliste fest.');
    const todo = { __id: `toolu_${randomUUID().slice(0, 8)}`, todos: [
      { content: 'ffmpeg prüfen', activeForm: 'Prüfe ffmpeg', status: 'completed' },
      { content: 'Seite aufnehmen', activeForm: 'Nehme Seite auf', status: 'in_progress' },
      { content: 'Video schneiden', activeForm: 'Schneide Video', status: 'pending' },
    ] };
    assistant([{ type: 'tool_use', id: todo.__id, name: 'TodoWrite', input: todo }]);
    toolResult(todo.__id, 'Todos aktualisiert');

    const bashId = `toolu_${randomUUID().slice(0, 8)}`;
    const bashInput = { command: 'ffmpeg -hide_banner -version | head -1', description: 'ffmpeg-Version prüfen', __id: bashId };
    assistant([{ type: 'tool_use', id: bashId, name: 'Bash', input: bashInput }]);
    const perm = await ask('Bash', bashInput, { title: 'Claude möchte einen Befehl ausführen', suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ffmpeg *' }], behavior: 'allow', destination: 'localSettings' }] });
    if (perm.behavior === 'deny') {
      toolResult(bashId, perm.message, { isError: true });
      await stream(`Verstanden, ich lasse ffmpeg weg. (${perm.message})`);
    } else {
      for (let s = 1; s <= 2; s++) { await sleep(500); emit({ type: 'tool_progress', tool_use_id: bashId, tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: s }); }
      toolResult(bashId, 'ffmpeg version 7.1.1-full_build-www.gyan.dev', { structured: { stdout: 'ffmpeg version 7.1.1-full_build-www.gyan.dev Copyright (c) 2000-2025 the FFmpeg developers\n', stderr: '', interrupted: false } });
    }
    if (interrupted) return finish(started, true);

    const navId = `toolu_${randomUUID().slice(0, 8)}`;
    const nav = { url: 'https://example.org/baeckerei', __id: navId };
    assistant([{ type: 'tool_use', id: navId, name: 'mcp__playwright__browser_navigate', input: nav }]);
    await ask('mcp__playwright__browser_navigate', nav);
    await sleep(600);
    toolResult(navId, [{ type: 'text', text: '### Page\n- URL: https://example.org/baeckerei\n- Title: Bergwerk Bäckerei' }]);

    const shotId = `toolu_${randomUUID().slice(0, 8)}`;
    assistant([{ type: 'tool_use', id: shotId, name: 'mcp__playwright__browser_take_screenshot', input: { filename: 'output/browser/startseite.png' } }]);
    await sleep(500);
    toolResult(shotId, [{ type: 'text', text: 'Screenshot gespeichert: output/browser/startseite.png' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SHOT() } }]);

    const outDir = path.join(options.cwd, 'output');
    fs.mkdirSync(path.join(outDir, 'browser'), { recursive: true });
    fs.copyFileSync(path.join(FIX, 'screenshot.png'), path.join(outDir, 'browser', 'startseite.png'));

    const qId = `toolu_${randomUUID().slice(0, 8)}`;
    const qInput = { __id: qId, questions: [{ question: 'Welches Format soll das Video haben?', header: 'Format', multiSelect: false, options: [{ label: '16:9, 1080p', description: 'YouTube, Website' }, { label: '9:16, 1080×1920', description: 'Reels, TikTok, Shorts' }] }] };
    assistant([{ type: 'tool_use', id: qId, name: 'AskUserQuestion', input: qInput }]);
    const ans = await ask('AskUserQuestion', qInput);
    const answer = ans.behavior === 'allow' ? Object.values(ans.updatedInput.answers ?? {}).join(', ') : 'selbst gewählt: 16:9';
    toolResult(qId, `Antwort: ${answer}`);
    if (interrupted) return finish(started, true);

    const editId = `toolu_${randomUUID().slice(0, 8)}`;
    assistant([{ type: 'tool_use', id: editId, name: 'Edit', input: { file_path: path.join(options.cwd, 'CLAUDE.md'), old_string: '- Videoformat: offen', new_string: `- Videoformat: ${answer}\n- Länge: 15 s` } }]);
    toolResult(editId, 'Datei aktualisiert');

    const renderId = `toolu_${randomUUID().slice(0, 8)}`;
    const render = { command: 'ffmpeg -y -framerate 30 -i output/frames/%04d.jpg -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p output/promo.mp4', description: 'Video rendern', __id: renderId };
    assistant([{ type: 'tool_use', id: renderId, name: 'Bash', input: render }]);
    const p2 = await ask('Bash', render, { title: 'Claude möchte das Video rendern' });
    if (p2.behavior === 'allow') {
      for (let s = 1; s <= 3; s++) { await sleep(400); emit({ type: 'tool_progress', tool_use_id: renderId, tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: s }); }
      fs.copyFileSync(path.join(FIX, 'demo.mp4'), path.join(outDir, 'promo.mp4'));
      toolResult(renderId, '', { structured: { stdout: '', stderr: 'frame=  450 fps=212 q=-1.0 Lsize=    1873kB time=00:00:15.00 bitrate=1022.8kbits/s speed=7.05x\n', interrupted: false } });
    } else toolResult(renderId, p2.message, { isError: true });

    await stream(`Fertig: **output/promo.mp4** (${answer}, 15 s). Der Screenshot liegt unter \`output/browser/startseite.png\`.\n\n| Datei | Größe |\n|---|---|\n| promo.mp4 | 1,8 MB |\n| startseite.png | 36 KB |`);
    finish(started, false);
  }

  function finish(started, wasInterrupted) {
    emit({ type: 'result', subtype: wasInterrupted ? 'error_during_execution' : 'success', is_error: wasInterrupted, duration_ms: Date.now() - started, duration_api_ms: Date.now() - started - 900, num_turns: 7, result: 'ok', total_cost_usd: totalCost, usage: {}, modelUsage: JSON.parse(JSON.stringify(modelUsage)), permission_denials: [] });
    emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  }

  const inputLoop = (async () => {
    for await (const msg of prompt) {
      if (closed) break;
      const text = typeof msg.message?.content === 'string' ? msg.message.content : '';
      if (text.startsWith('/clear')) {
        emit({ type: 'conversation_reset', new_conversation_id: randomUUID(), trigger: 'clear' });
        continue;
      }
      emit({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'started' });
      await turn(text);
    }
  })();

  async function* gen() {
    while (!closed) {
      while (out.length) yield out.shift();
      if (closed) break;
      await new Promise((r) => { wake = r; });
    }
  }
  const q = gen();
  const init = { commands: COMMANDS, models: MODELS, account: { email: 'demo@example.de', subscriptionType: 'max', tokenSource: 'claude.ai' }, agents: [], output_style: 'default', available_output_styles: [], claude_code_version: '2.1.330-mock' };
  Object.assign(q, {
    initializationResult: async () => init,
    supportedModels: async () => MODELS,
    supportedCommands: async () => COMMANDS,
    accountInfo: async () => init.account,
    interrupt: async () => { interrupted = true; },
    setModel: async () => {},
    setPermissionMode: async () => {},
    applyFlagSettings: async () => {},
    stopTask: async () => {},
    rewindFiles: async (_id, { dryRun }) => ({ canRewind: true, filesChanged: ['CLAUDE.md'], insertions: 2, deletions: 1, dryRun }),
    getContextUsage: async () => ({ totalTokens: ctxTokens, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, percentage: Math.round(ctxTokens / 10_000), categories: [
      { id: 'system_prompt', name: 'System prompt', tokens: 2100, kind: 'used' }, { id: 'system_tools', name: 'System tools', tokens: 17_700, kind: 'used' },
      { id: 'mcp_tools', name: 'MCP tools', tokens: 9800, kind: 'used' }, { id: 'memory_files', name: 'Memory files', tokens: 1300, kind: 'used' },
      { id: 'messages', name: 'Messages', tokens: Math.max(0, ctxTokens - 30_900), kind: 'used' }, { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
    ] }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
      usageCalls++;
      return {
        session: { total_cost_usd: totalCost }, subscription_type: 'max', rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: Math.min(100, 31 + usageCalls * 4.5), resets_at: new Date(fiveReset).toISOString() },
          seven_day: { utilization: 18 + usageCalls * 0.6, resets_at: new Date(Date.now() + 3.4 * 86400_000).toISOString() },
          seven_day_opus: { utilization: 9 + usageCalls * 0.4, resets_at: new Date(Date.now() + 3.4 * 86400_000).toISOString() },
        },
      };
    },
    close: () => { closed = true; wake?.(); },
  });
  emit({ type: 'autocompact_state', value: { enabled: true, effective_window: 980_000, threshold: 784_000, enforced: true, source: 'model-default' } });
  void inputLoop;
  return q;
}
