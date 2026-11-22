/** Per-session usage accounting, persisted in data/sessions/<projectId>/<sessionId>.json */

export function emptyStats(projectId, sessionId) {
  const now = Date.now();
  return {
    v: 1,
    projectId,
    sessionId,
    createdAt: now,
    updatedAt: now,
    firstPrompt: null,
    forkedFrom: null,
    costUsd: 0,
    turns: 0,
    apiCalls: 0,
    outTokens: 0,
    models: {},
    turnLog: [],
    context: { tokens: 0, max: 0, pct: 0, threshold: 0 },
    cacheTtl: null,
    lastApiAt: 0,
    model: null,
  };
}

const FIELDS = [
  ['in', 'inputTokens'],
  ['out', 'outputTokens'],
  ['cacheRead', 'cacheReadInputTokens'],
  ['cacheWrite', 'cacheCreationInputTokens'],
  ['cacheWrite5m', 'cacheCreationEphemeral5mInputTokens'],
  ['cacheWrite1h', 'cacheCreationEphemeral1hInputTokens'],
  ['cost', 'costUSD'],
];

/** modelUsage is cumulative per query() process; returns per-model deltas since `prev`. */
export function diffModelUsage(prev = {}, next = {}) {
  const out = {};
  for (const [model, u] of Object.entries(next ?? {})) {
    const p = prev?.[model] ?? {};
    const d = { canonical: u.canonicalModel ?? null, contextWindow: u.contextWindow ?? null };
    let any = false;
    for (const [k, src] of FIELDS) {
      const v = Math.max(0, (Number(u[src]) || 0) - (Number(p[src]) || 0));
      d[k] = v;
      if (v) any = true;
    }
    if (any) out[model] = d;
  }
  return out;
}

export function addModelUsage(stats, deltas) {
  for (const [model, d] of Object.entries(deltas)) {
    const acc = stats.models[model] ?? { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, cost: 0 };
    for (const [k] of FIELDS) acc[k] = (acc[k] ?? 0) + (d[k] ?? 0);
    if (d.canonical) acc.canonical = d.canonical;
    if (d.contextWindow) acc.contextWindow = d.contextWindow;
    stats.models[model] = acc;
  }
}

/** "$4/$20 per Mtok" in a model description → { in: 4, out: 20 } (USD per million tokens). */
export function parsePrice(description) {
  const m = String(description ?? '').match(/\$\s*(\d+(?:\.\d+)?)\s*\/\s*\$\s*(\d+(?:\.\d+)?)\s*per\s*M\s*tok/i);
  return m ? { in: Number(m[1]), out: Number(m[2]) } : null;
}

export function priceTable(models = []) {
  const table = {};
  for (const m of models) {
    const p = parsePrice(m.description);
    if (!p) continue;
    if (m.resolvedModel) table[m.resolvedModel] = p;
    table[m.value] = p;
  }
  return table;
}
