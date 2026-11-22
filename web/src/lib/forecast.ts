import type { Catalog, Limits, SessionStats } from './types';
import { clamp } from './format';

// Anthropic price ratios relative to the base input price (stable across current models):
// cache read 0.1×, cache write 1.25× (5-minute TTL) or 2× (1-hour TTL).
const READ = 0.1;
const WRITE_5M = 1.25;
const WRITE_1H = 2;
const CHARS_PER_TOKEN = 3.6; // German prose/code mix; English is closer to 4

export function priceFor(catalog: Catalog | null, model: string | null | undefined) {
  if (!catalog || !model) return null;
  const clean = model.replace(/\[.*?\]$/, '');
  return catalog.prices[model] ?? catalog.prices[clean] ?? null;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Ratio actual/modeled cost for the session – absorbs long-context premiums and price drift. */
function calibration(stats: SessionStats, catalog: Catalog | null) {
  let modeled = 0, actual = 0;
  for (const [model, u] of Object.entries(stats.models ?? {})) {
    const p = priceFor(catalog, u.canonical ?? model) ?? priceFor(catalog, model);
    if (!p) continue;
    const pin = p.in / 1e6, pout = p.out / 1e6;
    const w1h = u.cacheWrite1h ?? 0;
    const w5 = Math.max(0, (u.cacheWrite ?? 0) - w1h);
    modeled += u.in * pin + u.out * pout + u.cacheRead * pin * READ + w5 * pin * WRITE_5M + w1h * pin * WRITE_1H;
    actual += u.cost;
  }
  return modeled > 0.002 && actual > 0 ? clamp(actual / modeled, 0.4, 4) : 1;
}

export interface Estimate {
  draftTokens: number;
  ctxTokens: number;
  ctxAfter: number;
  single: number | null;       // one API call answering the prompt
  typical: number | null;      // median turn of this session, scaled to current context
  coldExtra: number;           // extra cost because the prompt cache expired
  warm: boolean;
  warmLeftMs: number;
  ttl: '5m' | '1h';
  avgCalls: number | null;
  turnsToCompact: number | null;
  pctOf5h: number | null;      // expected share of the 5-hour limit for a typical turn
  hasPrice: boolean;
}

export function estimate(stats: SessionStats | null, catalog: Catalog | null, limits: Limits | null, draftChars: number, model: string | null, now = Date.now()): Estimate {
  const draftTokens = Math.ceil(draftChars / CHARS_PER_TOKEN);
  const ctxTokens = stats?.context?.tokens ?? 0;
  const ttl = stats?.cacheTtl === '1h' ? '1h' : '5m';
  const ttlMs = ttl === '1h' ? 3600_000 : 300_000;
  const warmLeftMs = stats?.lastApiAt ? stats.lastApiAt + ttlMs - now : 0;
  const warm = warmLeftMs > 5_000;
  const price = priceFor(catalog, stats?.model ?? model) ?? priceFor(catalog, model);
  const outPerCall = stats && stats.apiCalls > 0 ? stats.outTokens / stats.apiCalls : 900;
  const recent = (stats?.turnLog ?? []).filter((t) => !t.cmd && !t.err && t.cost > 0).slice(-12);

  let single: number | null = null, typical: number | null = null, coldExtra = 0;
  if (price) {
    const pin = price.in / 1e6, pout = price.out / 1e6;
    const write = pin * (ttl === '1h' ? WRITE_1H : WRITE_5M);
    const k = stats ? calibration(stats, catalog) : 1;
    const ctxCost = ctxTokens * (warm ? pin * READ : write);
    single = k * (ctxCost + draftTokens * write + outPerCall * pout);
    coldExtra = warm ? 0 : k * ctxTokens * (write - pin * READ);
    const scaled = recent.map((t) => t.cost * (ctxTokens > 0 && t.ctxStart > 0 ? clamp(ctxTokens / t.ctxStart, 0.5, 3) : 1));
    const med = median(scaled);
    if (med != null) typical = med + coldExtra;
  }
  const avgCalls = recent.length ? recent.reduce((a, t) => a + t.calls, 0) / recent.length : null;

  // Context growth per turn → turns until auto-compact
  const growth = median(recent.map((t) => t.ctxEnd - t.ctxStart).filter((g) => g > 0));
  const threshold = stats?.context?.threshold || 0;
  const turnsToCompact = growth && threshold > ctxTokens ? Math.floor((threshold - ctxTokens) / growth) : null;

  const ratio = limits?.forecast?.pctPerUsd5h ?? null;
  const pctOf5h = ratio != null && (typical ?? single) != null ? ratio * (typical ?? single ?? 0) : null;

  return {
    draftTokens, ctxTokens, ctxAfter: ctxTokens + draftTokens + Math.round(outPerCall),
    single, typical, coldExtra, warm, warmLeftMs, ttl, avgCalls, turnsToCompact, pctOf5h, hasPrice: !!price,
  };
}
