/**
 * Self-contained chart pages (HTML + inline SVG, no scripts, no external files) – the cockpit
 * preview is sandboxed, so everything has to be inside one file. Forms: bar (grouped), line, area,
 * scatter. Palette and chrome follow the dataviz reference palette (validated categorical order,
 * selected light/dark steps); hover values via SVG <title>, legend from 2 series on, direct labels
 * at line ends for ≤ 4 series, and a table view of the same data.
 */

const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];
const TYPES = ['bar', 'line', 'area', 'scatter'];
const MAX_SERIES = { bar: 8, line: 8, area: 8, scatter: 3 };
const MAX_POINTS = 2000;

const W = 960, H = 440;
const M = { top: 16, right: 132, bottom: 44, left: 64 };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });
const nfCompact = new Intl.NumberFormat('de-DE', { notation: 'compact', maximumFractionDigits: 1 });
const fmt = (v) => (Math.abs(v) >= 10_000 ? nfCompact.format(v) : nf.format(v));

/** "Nice" axis: rounded bounds and 4–6 ticks. */
function niceScale(min, max, zero) {
  if (zero) { min = Math.min(0, min); max = Math.max(0, max); }
  if (min === max) { max = min + 1; if (!zero) min -= 1; }
  const span = max - min;
  const step0 = 10 ** Math.floor(Math.log10(span / 5));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * step0).find((s) => span / s <= 6) ?? step0 * 10;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { lo, hi, ticks };
}

/** Validates and normalises the input; throws Error with a German message for Claude. */
export function normalizeChart(input) {
  const type = TYPES.includes(input.type) ? input.type : 'bar';
  const labels = (input.labels ?? []).map((l) => String(l ?? ''));
  const series = (input.series ?? []).map((s) => ({ name: String(s.name ?? 'Wert').slice(0, 60), values: (s.values ?? []).map((v) => (v == null || v === '' ? null : Number(v))) }));
  if (!series.length) throw new Error('series fehlt – z. B. [{"name":"Umsatz","values":[1,2,3]}]');
  if (series.length > MAX_SERIES[type]) throw new Error(`${type}: höchstens ${MAX_SERIES[type]} Reihen – kleinere zu „Andere“ zusammenfassen oder mehrere Diagramme`);
  if (type === 'scatter') {
    // scatter: labels are numeric x values
    if (labels.some((l) => Number.isNaN(Number(l)))) throw new Error('scatter: labels müssen Zahlen (x-Werte) sein');
  }
  const n = labels.length || Math.max(...series.map((s) => s.values.length));
  if (!n) throw new Error('keine Datenpunkte');
  if (n > MAX_POINTS) throw new Error(`höchstens ${MAX_POINTS} Punkte – vorher aggregieren`);
  for (const s of series) {
    if (s.values.some((v) => v != null && !Number.isFinite(v))) throw new Error(`Reihe „${s.name}“ enthält keine Zahlen`);
    s.values.length = n;
  }
  return { type, title: String(input.title ?? '').slice(0, 120), xLabel: String(input.xLabel ?? '').slice(0, 60), yLabel: String(input.yLabel ?? '').slice(0, 60), labels: labels.length ? labels : [...Array(n).keys()].map((i) => String(i + 1)), series };
}

export function renderChart(input) {
  const c = normalizeChart(input);
  const { type, labels, series } = c;
  const iw = W - M.left - M.right, ih = H - M.top - M.bottom;
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  const ys = niceScale(Math.min(...all), Math.max(...all), type === 'bar' || type === 'area');
  const y = (v) => M.top + ih - ((v - ys.lo) / (ys.hi - ys.lo)) * ih;
  const parts = [];

  // grid + y axis (recessive)
  for (const t of ys.ticks) {
    parts.push(`<line class="grid" x1="${M.left}" x2="${M.left + iw}" y1="${y(t)}" y2="${y(t)}"/>`);
    parts.push(`<text class="tick" x="${M.left - 8}" y="${y(t) + 4}" text-anchor="end">${esc(fmt(t))}</text>`);
  }
  const base = y(Math.max(ys.lo, Math.min(0, ys.hi)));

  // x positions
  let x, xTicks;
  if (type === 'scatter') {
    const xsv = labels.map(Number);
    const xs = niceScale(Math.min(...xsv), Math.max(...xsv), false);
    x = (i) => M.left + ((xsv[i] - xs.lo) / (xs.hi - xs.lo)) * iw;
    xTicks = xs.ticks.map((t) => [M.left + ((t - xs.lo) / (xs.hi - xs.lo)) * iw, fmt(t)]);
  } else if (type === 'bar') {
    const band = iw / labels.length;
    x = (i) => M.left + band * (i + 0.5);
    const every = Math.ceil(labels.length / 12);
    xTicks = labels.map((l, i) => [x(i), l]).filter((_, i) => i % every === 0);
  } else {
    const step = labels.length > 1 ? iw / (labels.length - 1) : 0;
    x = (i) => M.left + (labels.length > 1 ? step * i : iw / 2);
    const every = Math.ceil(labels.length / 10);
    xTicks = labels.map((l, i) => [x(i), l]).filter((_, i) => i % every === 0 || i === labels.length - 1);
  }
  for (const [px, l] of xTicks) parts.push(`<text class="tick" x="${px}" y="${M.top + ih + 18}" text-anchor="middle">${esc(String(l).slice(0, 16))}</text>`);
  parts.push(`<line class="axis" x1="${M.left}" x2="${M.left + iw}" y1="${base}" y2="${base}"/>`);
  if (c.yLabel) parts.push(`<text class="tick" x="${M.left}" y="${M.top - 4}" text-anchor="start">${esc(c.yLabel)}</text>`);
  if (c.xLabel) parts.push(`<text class="tick" x="${M.left + iw}" y="${H - 6}" text-anchor="end">${esc(c.xLabel)}</text>`);

  const tip = (s, i) => `${esc(s.name)} · ${esc(labels[i])}: ${s.values[i] == null ? '–' : esc(nf.format(s.values[i]))}`;

  if (type === 'bar') {
    const band = iw / labels.length;
    const group = band * 0.78, gap = 2;
    const bw = Math.max(1, (group - gap * (series.length - 1)) / series.length);
    series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        if (v == null) return;
        const x0 = x(i) - group / 2 + si * (bw + gap);
        const top = Math.min(y(v), base), h = Math.max(1, Math.abs(y(v) - base));
        const r = Math.min(4, bw / 2, h);
        // rounded at the data end, square on the baseline
        const d = v >= 0
          ? `M${x0},${top + h}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${top + h}Z`
          : `M${x0},${top}V${top + h - r}Q${x0},${top + h} ${x0 + r},${top + h}H${x0 + bw - r}Q${x0 + bw},${top + h} ${x0 + bw},${top + h - r}V${top}Z`;
        parts.push(`<path class="s${si} fill" d="${d}"><title>${tip(s, i)}</title></path>`);
      });
    });
  } else if (type === 'line' || type === 'area') {
    series.forEach((s, si) => {
      const segs = [];
      let cur = [];
      s.values.forEach((v, i) => { if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(v)]); });
      if (cur.length) segs.push(cur);
      for (const seg of segs) {
        const d = seg.map(([px, py], k) => `${k ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
        if (type === 'area' && series.length === 1) parts.push(`<path class="s${si} area" d="${d}L${seg.at(-1)[0]},${base}L${seg[0][0]},${base}Z"/>`);
        parts.push(`<path class="s${si} stroke" d="${d}"/>`);
      }
      // hover targets bigger than the mark, invisible until hovered
      s.values.forEach((v, i) => { if (v != null) parts.push(`<circle class="s${si} dot" cx="${x(i)}" cy="${y(v)}" r="9"><title>${tip(s, i)}</title></circle>`); });
    });
    // direct labels at the line ends (≤ 4 series), nudged apart
    if (series.length <= 4 && series.length > 1) {
      const ends = series.map((s, si) => { const i = s.values.findLastIndex((v) => v != null); return { si, yy: i < 0 ? null : y(s.values[i]), name: s.name }; }).filter((e) => e.yy != null).sort((a, b) => a.yy - b.yy);
      for (let k = 1; k < ends.length; k++) if (ends[k].yy - ends[k - 1].yy < 14) ends[k].yy = ends[k - 1].yy + 14;
      for (const e of ends) parts.push(`<circle class="s${e.si} key" cx="${M.left + iw + 10}" cy="${e.yy}" r="4"/><text class="label" x="${M.left + iw + 18}" y="${e.yy + 4}">${esc(e.name.slice(0, 18))}</text>`);
    }
  } else {
    series.forEach((s, si) => s.values.forEach((v, i) => { if (v != null) parts.push(`<circle class="s${si} mark" cx="${x(i)}" cy="${y(v)}" r="4"><title>${tip(s, i)}</title></circle>`); }));
  }

  const legend = series.length >= 2
    ? `<div class="legend">${series.map((s, si) => `<span><i class="sw s${si}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  const table = `<details><summary>Tabelle</summary><table><thead><tr><th>${esc(c.xLabel || '')}</th>${series.map((s) => `<th>${esc(s.name)}</th>`).join('')}</tr></thead><tbody>${
    labels.map((l, i) => `<tr><td>${esc(l)}</td>${series.map((s) => `<td>${s.values[i] == null ? '–' : esc(nf.format(s.values[i]))}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
  const vars = (cols) => cols.map((h, i) => `--s${i}:${h};`).join('');
  const seriesCss = SERIES_LIGHT.map((_, i) => `.s${i}{--c:var(--s${i})}`).join('');

  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.title || 'Diagramm')}</title>
<style>
:root{color-scheme:light;--surface:#fcfcfb;--page:#f9f9f7;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;${vars(SERIES_LIGHT)}}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--surface:#1a1a19;--page:#0d0d0d;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;${vars(SERIES_DARK)}}}
${seriesCss}
body{margin:0;background:var(--page);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:${W}px;margin:24px auto;padding:20px 20px 12px;background:var(--surface);border-radius:8px}
h1{font-size:18px;font-weight:600;margin:0 0 10px}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:0 0 8px;color:var(--ink2);font-size:13px}
.legend span{display:inline-flex;align-items:center;gap:6px}.sw{width:10px;height:10px;border-radius:2px;background:var(--c)}
svg{width:100%;height:auto;display:block}
.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1}
.tick{fill:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}.label{fill:var(--ink2);font-size:12px}
.fill{fill:var(--c)}.fill:hover{opacity:.85}
.stroke{fill:none;stroke:var(--c);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.area{fill:var(--c);opacity:.14}
.dot{fill:var(--c);fill-opacity:0;stroke:var(--surface);stroke-width:2;stroke-opacity:0}.dot:hover{fill-opacity:1;stroke-opacity:1;r:5}
.mark{fill:var(--c);stroke:var(--surface);stroke-width:2}.key{fill:var(--c)}
details{margin-top:8px;color:var(--ink2);font-size:13px}summary{cursor:pointer}
table{border-collapse:collapse;margin-top:6px;font-variant-numeric:tabular-nums}td,th{padding:3px 10px;text-align:right;border-bottom:1px solid var(--grid)}td:first-child,th:first-child{text-align:left}
</style></head>
<body><main>
${c.title ? `<h1>${esc(c.title)}</h1>` : ''}${legend}
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.title || 'Diagramm')}">${parts.join('')}</svg>
${table}
</main></body></html>
`;
}

/** SQL result {columns, rows} → chart input: x column + one or more numeric y columns. */
export function chartFromRows({ columns, rows }, { x, y, ...rest }) {
  const xi = x ? columns.indexOf(x) : 0;
  if (xi < 0) throw new Error(`Spalte „${x}“ nicht im Ergebnis (${columns.join(', ')})`);
  const yCols = (y?.length ? y : columns.filter((_, i) => i !== xi)).slice(0, 8);
  const idx = yCols.map((c) => { const i = columns.indexOf(c); if (i < 0) throw new Error(`Spalte „${c}“ nicht im Ergebnis (${columns.join(', ')})`); return i; });
  return {
    ...rest,
    xLabel: rest.xLabel ?? columns[xi],
    labels: rows.map((r) => r[xi]),
    series: yCols.map((name, k) => ({ name, values: rows.map((r) => r[idx[k]]) })),
  };
}
