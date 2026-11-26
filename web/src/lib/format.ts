import { locale } from './i18n';
const usd = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdFine = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 });
const num1 = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
const num0 = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
const dayTime = new Intl.DateTimeFormat(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const date = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export const fmtUsd = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return '–';
  return v > 0 && v < 0.1 ? usdFine.format(v) : usd.format(v);
};

export const fmtTokens = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return '–';
  if (v >= 1_000_000) return `${num1.format(v / 1_000_000)} M`;
  if (v >= 10_000) return `${num0.format(v / 1000)} k`;
  if (v >= 1000) return `${num1.format(v / 1000)} k`;
  return num0.format(v);
};

export const fmtPct = (v: number | null | undefined, digits = 0) =>
  v == null || !Number.isFinite(v) ? '–' : `${v.toLocaleString(locale, { maximumFractionDigits: digits })} %`;

export const fmtDuration = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
};

export const fmtCountdown = (ms: number) => {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
};

export const fmtClock = (t: number | null | undefined) => (t ? time.format(t) : '–');
export const fmtDayClock = (t: number | null | undefined) => (t ? dayTime.format(t) : '–');
export const fmtDate = (t: number | null | undefined) => (t ? date.format(t) : '–');

export function fmtAgo(t: number | null | undefined, now = Date.now()) {
  if (!t) return '–';
  const d = Math.max(0, now - t);
  if (d < 60_000) return 'gerade';
  if (d < 3600_000) return `vor ${Math.round(d / 60_000)} min`;
  if (d < 24 * 3600_000) return `vor ${Math.round(d / 3600_000)} h`;
  return fmtDate(t);
}

export const fmtBytes = (b: number | null | undefined) => {
  if (b == null) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${num1.format(b / 1024)} KB`;
  if (b < 1024 ** 3) return `${num1.format(b / 1024 ** 2)} MB`;
  return `${num1.format(b / 1024 ** 3)} GB`;
};

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function shortModel(m: string | null | undefined) {
  if (!m) return 'Standard';
  return m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)/, ' $1.$2').replace(/\[.*?\]$/, '').replace(/^./, (c) => c.toUpperCase());
}

export const MODE_LABEL: Record<string, string> = {
  default: 'Nachfragen',
  acceptEdits: 'Edits automatisch',
  auto: 'Auto (Klassifikator)',
  plan: 'Planen',
  dontAsk: 'Nicht fragen – Rest wird abgelehnt',
  bypassPermissions: 'Alles erlauben',
};

export const STATE_LABEL: Record<string, string> = {
  idle: 'bereit',
  starting: 'startet',
  ready: 'wartet auf Prompt',
  running: 'arbeitet',
  waiting: 'wartet auf Freigabe',
  error: 'Fehler',
};
