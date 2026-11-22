import { fmtClock } from '../lib/format';
import type { Forecast, LimitWindow } from '../lib/types';

const W = 352, H = 66, TOP = 6, BOT = 50;
const WINDOW_MS = 5 * 3600_000;

/**
 * The 5-hour window as a timetable: x = time from window start to reset, y = utilization.
 * Solid: measured samples. Dashed: projection from the current burn rate.
 */
export function Fahrplan({ window: w, series, forecast, now }: { window: LimitWindow; series: { t: number; u: number }[]; forecast?: Forecast; now: number }) {
  const end = w.resetsAt ?? now + WINDOW_MS / 2;
  const start = end - WINDOW_MS;
  const x = (t: number) => Math.max(0, Math.min(W, ((t - start) / WINDOW_MS) * W));
  const y = (u: number) => BOT - (Math.max(0, Math.min(100, u)) / 100) * (BOT - TOP);

  const pts = [...series.filter((p) => p.t >= start && p.t <= now)];
  if (!pts.length || pts[pts.length - 1].t < now - 60_000) pts.push({ t: now, u: w.u });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.u).toFixed(1)}`).join(' ');
  const area = pts.length > 1 ? `${line} L${x(pts[pts.length - 1].t).toFixed(1)},${BOT} L${x(pts[0].t).toFixed(1)},${BOT} Z` : '';

  let proj: { x2: number; y2: number; bad: boolean; hitX?: number } | null = null;
  if (forecast?.perHour && forecast.perHour > 0) {
    const perMs = forecast.perHour / 3600_000;
    const tEnd = forecast.eta && forecast.eta < end ? forecast.eta : end;
    proj = { x2: x(tEnd), y2: y(w.u + perMs * (tEnd - now)), bad: !!forecast.hitsBeforeReset, hitX: forecast.hitsBeforeReset && forecast.eta ? x(forecast.eta) : undefined };
  }

  const hours = [1, 2, 3, 4].map((h) => start + h * 3600_000);
  return (
    <svg className="fahrplan" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`5-Stunden-Fenster: ${Math.round(w.u)} Prozent genutzt${forecast?.eta ? `, Prognose voll um ${fmtClock(forecast.eta)}` : ''}`}>
      <line className="limit" x1={0} x2={W} y1={TOP} y2={TOP} />
      <line className="grid" x1={0} x2={W} y1={BOT} y2={BOT} />
      {hours.map((t) => <line key={t} className="grid" x1={x(t)} x2={x(t)} y1={BOT} y2={BOT + 3} />)}
      {area && <path className="area" d={area} />}
      <path className="hist" d={line} />
      {proj && <line className={`proj${proj.bad ? ' bad' : ''}`} x1={x(now)} y1={y(w.u)} x2={proj.x2} y2={proj.y2} />}
      {proj?.hitX != null && <circle className="hit" cx={proj.hitX} cy={TOP} r={3} />}
      <line className="now" x1={x(now)} x2={x(now)} y1={TOP - 2} y2={BOT + 4} />
      <circle className="cur" cx={x(now)} cy={y(w.u)} r={3.2} />
      <text x={0} y={H - 2}>{fmtClock(start)}</text>
      <text x={Math.min(W - 26, Math.max(26, x(now)))} y={H - 2} textAnchor="middle" className="strong">jetzt</text>
      <text x={W} y={H - 2} textAnchor="end">{fmtClock(end)}</text>
      <text x={W - 2} y={TOP + 10} textAnchor="end">100 %</text>
    </svg>
  );
}
