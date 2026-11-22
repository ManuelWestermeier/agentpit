import { ChevronDown, ChevronRight, RefreshCw, Square } from 'lucide-react';
import { useState } from 'react';
import { estimate } from '../lib/forecast';
import { fmtClock, fmtCountdown, fmtDayClock, fmtPct, fmtTokens, fmtUsd } from '../lib/format';
import { ls, useActive, useNow } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import type { LimitWindow } from '../lib/types';
import { conn } from '../lib/ws';
import { Fahrplan } from './Fahrplan';

const CAT_COLORS = ['#e7e5dd', '#a8aea9', '#8bb6db', '#74c49a', '#f0a73a', '#c99ce0', '#6f7873'];

export function UsagePanel() {
  const [open, setOpen] = useState(() => ls.get('cockpit.usage', '1') === '1');
  const toggle = () => setOpen((o) => { ls.set('cockpit.usage', o ? '0' : '1'); return !o; });
  return (
    <section className={`usage${open ? '' : ' closed'}`} aria-label="Verbrauch">
      <button className="usage-toggle" onClick={toggle} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Verbrauch
        {!open && <Summary />}
      </button>
      {open && <><PlanLimits /><SessionUsage /></>}
    </section>
  );
}

function Summary() {
  const limits = useStore((s) => s.limits);
  const { runner } = useActive();
  const st = runner?.stats;
  const parts = [
    limits?.windows.five_hour ? `5 h ${fmtPct(limits.windows.five_hour.u)}` : null,
    limits?.windows.seven_day ? `Woche ${fmtPct(limits.windows.seven_day.u)}` : null,
    st ? `Session ${fmtUsd(st.costUsd)}` : null,
    st?.context?.tokens ? `Kontext ${fmtTokens(st.context.tokens)}` : null,
  ].filter(Boolean);
  return <span className="usage-summary">{parts.join(' · ')}</span>;
}

function PlanLimits() {
  const limits = useStore((s) => s.limits);
  const now = useNow(15_000);
  const [busy, setBusy] = useState(false);
  const refresh = async () => { setBusy(true); await act(() => conn.call('usage.refresh', {}, 90_000)); setBusy(false); };

  const w5 = limits?.windows.five_hour ?? null;
  const f5 = limits?.forecast.five_hour;
  const weekly: [string, LimitWindow | null | undefined][] = [
    ['Woche, alle Modelle', limits?.windows.seven_day],
    ['Woche, Opus', limits?.windows.seven_day_opus],
    ['Woche, Sonnet', limits?.windows.seven_day_sonnet],
    ...(limits?.modelScoped ?? []).map((m) => [`Woche, ${m.name}`, { u: m.u, resetsAt: m.resetsAt }] as [string, LimitWindow]),
  ];

  return (
    <div className="u-block">
      <div className="u-head">
        <span className="u-title">Plan-Limits{limits?.subscription ? ` · ${limits.subscription}` : ''}</span>
        <button className="u-action" onClick={refresh} disabled={busy} title={limits?.at ? `Stand ${fmtClock(limits.at)}` : 'Abfragen'}>
          <RefreshCw size={11} className={busy ? 'spin' : ''} /> {limits?.at ? fmtClock(limits.at) : 'abfragen'}
        </button>
      </div>
      {limits?.available === false && <div className="big-sub">Keine Plan-Limits für diese Anmeldung (API-Key / Cloud-Anbieter). Kosten siehe Session.</div>}
      {limits?.available == null && !w5 && <div className="big-sub">Noch keine Daten. Erscheinen nach dem ersten Turn oder per „abfragen“.</div>}
      {w5 && (
        <>
          <div className="big">
            <span className="num">{Math.round(w5.u)}</span><span className="unit">% von 5 h{w5.approx ? ' (ca.)' : ''}</span>
          </div>
          <Fahrplan window={w5} series={limits?.series?.five_hour ?? []} forecast={f5} now={now} />
          <div className={`big-sub${f5?.hitsBeforeReset ? ' bad' : ''}`}>
            {w5.resetsAt ? `Reset ${fmtClock(w5.resetsAt)} (in ${fmtCountdown(w5.resetsAt - now).replace(/:\d\d$/, '')} h)` : ''}
            {f5?.eta ? (f5.hitsBeforeReset ? ` · bei diesem Tempo voll um ${fmtClock(f5.eta)}` : ' · reicht bis zum Reset') : ''}
            {f5?.perHour ? ` · ${fmtPct(f5.perHour, 1)}/h` : ''}
          </div>
        </>
      )}
      {weekly.filter(([, w]) => w).map(([label, w]) => (
        <div className="w-row" key={label}>
          <span>{label}</span>
          <span className="w-val">{fmtPct(w!.u)}</span>
          <div className={`meter${w!.u >= 90 ? ' full' : w!.u >= 70 ? ' hot' : ''}`}><i style={{ width: `${Math.min(100, w!.u)}%` }} /></div>
          {w!.resetsAt && <span className="w-sub">Reset {fmtDayClock(w!.resetsAt)}</span>}
        </div>
      ))}
      {limits?.extra?.is_enabled && (
        <div className="w-row">
          <span>Zusatznutzung</span>
          <span className="w-val">{limits.extra.used_credits != null ? `${limits.extra.used_credits} ${limits.extra.currency ?? ''}` : '–'}</span>
          {limits.extra.utilization != null && <div className="meter"><i style={{ width: `${Math.min(100, limits.extra.utilization)}%` }} /></div>}
        </div>
      )}
    </div>
  );
}

function SessionUsage() {
  const { project, runner } = useActive();
  const catalog = useStore((s) => s.catalog);
  const limits = useStore((s) => s.limits);
  const draft = useStore((s) => (s.activeId ? s.draft[s.activeId] ?? '' : ''));
  const now = useNow(1000);
  const stats = runner?.stats;
  if (!project) return null;
  if (!stats) {
    return (
      <div className="u-block">
        <div className="u-head"><span className="u-title">Session</span></div>
        <div className="big-sub">Neue Session – Werte erscheinen nach dem ersten Prompt.</div>
      </div>
    );
  }
  const tot = Object.values(stats.models ?? {}).reduce((a, m) => ({ in: a.in + m.in, out: a.out + m.out, cr: a.cr + m.cacheRead, cw: a.cw + m.cacheWrite }), { in: 0, out: 0, cr: 0, cw: 0 });
  const ctx = stats.context;
  const max = ctx.max || ctx.window || (ctx.threshold ? Math.round(ctx.threshold / 0.8) : 200_000);
  const pct = ctx.tokens ? (ctx.tokens / max) * 100 : 0;
  const thrPct = ctx.threshold ? (ctx.threshold / max) * 100 : null;
  const est = estimate(stats, catalog, limits, draft.length, runner?.model ?? project.model, now);
  const subscription = !!limits?.subscription;
  const cats = ctx.categories ?? [];
  const catTotal = cats.reduce((a, c) => a + c.tokens, 0) || 1;

  return (
    <>
      <div className="u-block">
        <div className="u-head">
          <span className="u-title">Session</span>
          <span className="faint" style={{ fontSize: 'var(--t-xs)' }}>{subscription ? 'API-Gegenwert' : 'Kosten'}</span>
        </div>
        <div className="big"><span className="num">{fmtUsd(stats.costUsd)}</span><span className="unit">{stats.turns} Turns · {stats.apiCalls} Calls</span></div>
        <dl className="kv">
          <dt>Eingabe neu</dt><dd>{fmtTokens(tot.in)}</dd>
          <dt>Cache gelesen / geschrieben</dt><dd>{fmtTokens(tot.cr)} / {fmtTokens(tot.cw)}</dd>
          <dt>Ausgabe</dt><dd>{fmtTokens(tot.out)}</dd>
        </dl>
      </div>
      <div className="u-block">
        <div className="u-head">
          <span className="u-title">Kontext</span>
          <span className="num" style={{ fontSize: 'var(--t-s)' }}>{fmtTokens(ctx.tokens)} / {fmtTokens(max)}</span>
        </div>
        <div className={`meter${thrPct && pct >= thrPct - 8 ? ' hot' : ''}`} title={thrPct ? `Auto-Compact bei ${fmtTokens(ctx.threshold)}` : ''}>
          <i style={{ width: `${Math.min(100, pct)}%` }} />
          {thrPct != null && <b style={{ left: `${Math.min(99.5, thrPct)}%` }} />}
        </div>
        {cats.length > 0 && (
          <>
            <div className="ctx-cats" aria-hidden>{cats.map((c, i) => <i key={c.id} style={{ width: `${(c.tokens / catTotal) * 100}%`, background: CAT_COLORS[i % CAT_COLORS.length] }} title={`${c.name}: ${fmtTokens(c.tokens)}`} />)}</div>
            <div className="big-sub">{cats.slice(0, 4).map((c) => `${c.name} ${fmtTokens(c.tokens)}`).join(' · ')}</div>
          </>
        )}
        <div className="big-sub">
          {fmtPct(pct)} belegt{thrPct != null ? ` · Auto-Compact bei ${fmtPct(thrPct)}` : ''}{est.turnsToCompact != null ? ` · ≈ ${est.turnsToCompact} Turns bis dahin` : ''}
        </div>
      </div>
      <div className="u-block">
        <div className="u-head"><span className="u-title">Prognose nächster Prompt</span></div>
        {!est.hasPrice && <div className="big-sub">Preise unbekannt – Modellliste wird beim ersten Start geladen.</div>}
        {est.single != null && <div className="forecast-line"><span>Ein Call (Minimum)</span><b>{fmtUsd(est.single)}</b></div>}
        {est.typical != null && <div className="forecast-line"><span>Typischer Turn{est.avgCalls ? `, ≈ ${Math.round(est.avgCalls)} Calls` : ''}</span><b>{fmtUsd(est.typical)}</b></div>}
        {est.pctOf5h != null && <div className="forecast-line"><span>Anteil am 5-h-Limit</span><b>≈ {fmtPct(est.pctOf5h, 1)}</b></div>}
        <div className="forecast-line">
          <span>Prompt-Cache ({est.ttl})</span>
          {est.warm ? <b className="tab-nums">warm, {fmtCountdown(est.warmLeftMs)}</b> : <b style={{ color: est.ctxTokens ? 'var(--amber)' : undefined }}>{est.ctxTokens ? `kalt, +${fmtUsd(est.coldExtra)}` : '–'}</b>}
        </div>
        {draft && <div className="big-sub">Entwurf ≈ {fmtTokens(est.draftTokens)} Tokens → Kontext danach ≈ {fmtTokens(est.ctxAfter)}</div>}
      </div>
      {!!runner?.bgTasks?.length && (
        <div className="u-block">
          <div className="u-head"><span className="u-title">Hintergrund ({runner.bgTasks.length})</span></div>
          {runner.bgTasks.map((t) => (
            <div className="bg-task" key={t.task_id}>
              <span title={t.description}>{t.description || t.task_type}</span>
              <button className="btn ghost small" onClick={() => act(() => conn.call('stopTask', { projectId: project.id, taskId: t.task_id }))}><Square size={9} fill="currentColor" /> Stopp</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
