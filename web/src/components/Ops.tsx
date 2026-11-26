import { Activity, Cloud, Copy, Loader2, Power, X } from 'lucide-react';
import { useState } from 'react';
import { act, useStore } from '../lib/store';
import { conn } from '../lib/ws';

export interface MonitorSnapshot {
  at: number; level: 'ok' | 'warning' | 'critical';
  cpu: number; cores: number; load: number[];
  mem: { used: number; total: number; pct: number };
  disk: { free: number; total: number; pct: number } | null;
  temp: number | null; uptime: number; host: string; platform: string; cockpitMb: number; sessions: number;
  browsers: { id: string; name: string; cpu: number | null; processes: number; viewers: number }[];
  history: [number, number][];
}
export interface TunnelSnapshot { status: 'off' | 'installing' | 'starting' | 'on' | 'error'; mode: string | null; url: string | null; error: string | null; lines: string[]; installed: boolean; hasToken: boolean }

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(b < 10 * 1024 ** 3 ? 1 : 0)} GB`;
const dur = (s: number) => (s > 86400 ? `${Math.floor(s / 86400)} d` : s > 3600 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 60)} min`);

/** CPU / RAM of the server in the header; red when it is overloaded. Click → details. */
export function ServerPill() {
  const m = useStore((s) => s.monitor);
  const [open, setOpen] = useState(false);
  if (!m) return null;
  return (
    <span className="srv-wrap">
      <button className={`usage-pill srv ${m.level}`} onClick={() => setOpen((v) => !v)} title="Server-Auslastung" aria-expanded={open}>
        <Activity size={12} /> <span className="tab-nums">CPU {m.cpu} % · RAM {m.mem.pct} %</span>
      </button>
      {open && <ServerPanel m={m} onClose={() => setOpen(false)} />}
    </span>
  );
}

function Spark({ values, max = 100 }: { values: number[]; max?: number }) {
  const w = 160, h = 28;
  if (values.length < 2) return null;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (Math.min(v, max) / max) * (h - 2) - 1}`).join(' ');
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
}

function Bar({ label, pct, text }: { label: string; pct: number; text: string }) {
  return (
    <div className="srv-bar">
      <span>{label}</span>
      <div className="srv-track"><i style={{ width: `${Math.min(100, pct)}%` }} className={pct >= 90 ? 'hot' : pct >= 75 ? 'warm' : ''} /></div>
      <span className="tab-nums">{text}</span>
    </div>
  );
}

function ServerPanel({ m, onClose }: { m: MonitorSnapshot; onClose: () => void }) {
  return (
    <div className="srv-panel" role="dialog" aria-label="Server">
      <div className="srv-head"><b data-i18n-skip>{m.host}</b><small className="muted">{m.platform} · läuft seit {dur(m.uptime)}</small><span className="spacer" /><button className="btn ghost icon small" aria-label="Schließen" onClick={onClose}><X size={12} /></button></div>
      {m.level !== 'ok' && <div className={`srv-alert ${m.level}`}>{m.level === 'critical' ? 'Server dauerhaft überlastet – Sessions oder Browser beenden.' : 'Server stark ausgelastet.'}</div>}
      <Bar label="CPU" pct={m.cpu} text={`${m.cpu} % · ${m.cores} Kerne`} />
      <Bar label="RAM" pct={m.mem.pct} text={`${gb(m.mem.used)} / ${gb(m.mem.total)}`} />
      {m.disk && <Bar label="Disk" pct={m.disk.pct} text={`${gb(m.disk.free)} frei`} />}
      <div className="srv-spark"><span className="muted">CPU, letzte 3 min</span><Spark values={m.history.map((h) => h[0])} /></div>
      <div className="srv-facts muted tab-nums">
        Last {m.load.join(' / ')}{m.temp != null ? ` · ${m.temp} °C` : ''} · Cockpit {m.cockpitMb} MB · {m.sessions} Sessions aktiv
      </div>
      {m.browsers.length > 0 && (
        <table className="srv-table">
          <tbody>
            {m.browsers.map((b) => (
              <tr key={b.id}><td>{b.name}</td><td className="tab-nums">{b.cpu == null ? '…' : `${b.cpu} %`}</td><td className="muted tab-nums">{b.processes} Prozesse{b.viewers ? ` · ${b.viewers} schauen zu` : ''}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Account dialog: remote access through Cloudflare Tunnel in one click. */
export function TunnelSection() {
  const t = useStore((s) => s.tunnel);
  const [copied, setCopied] = useState(false);
  if (!t) return null;
  const busy = t.status === 'installing' || t.status === 'starting';
  return (
    <section>
      <h3><Cloud size={14} /> Fernzugriff über Cloudflare</h3>
      <p className="muted">Ohne offenen Port und ohne Router-Einstellungen: verschlüsselt (HTTPS) von überall erreichbar, geschützt durch die Anmeldung.
        {t.hasToken ? ' Mit deinem Tunnel-Token (eigene Domain).' : ' Ohne Konto bekommst du eine zufällige Adresse, die sich bei jedem Start ändert. Für eine feste Adresse: CLOUDFLARE_TUNNEL_TOKEN in die .env.'}</p>
      {t.url && t.status === 'on' && (
        <div className="tunnel-url">
          <a href={t.url} target="_blank" rel="noreferrer" data-i18n-skip>{t.url}</a>
          <button className="btn ghost icon small" title="Kopieren" onClick={() => navigator.clipboard.writeText(t.url!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}><Copy size={12} /></button>
          {copied && <small className="muted">kopiert</small>}
        </div>
      )}
      {t.error && <p className="err">{t.error}</p>}
      <div className="perm-actions">
        {t.status === 'off' || t.status === 'error'
          ? <button className="btn primary" disabled={busy} onClick={() => act(() => conn.call('tunnel.start'))}>{t.installed ? 'Tunnel starten' : 'cloudflared laden und starten'}</button>
          : <button className="btn" onClick={() => act(() => conn.call('tunnel.stop'))}>{busy ? <Loader2 size={13} className="spin" /> : <Power size={13} />} {t.status === 'on' ? 'Tunnel beenden' : 'Abbrechen'}</button>}
      </div>
      {busy && <div className="login-out">{t.lines.slice(-4).join('\n') || (t.status === 'installing' ? 'lade cloudflared …' : 'verbinde …')}</div>}
      <p className="muted small">Dauerhaft: <code>npx agentpit --tunnel</code> oder <code>TUNNEL=on</code> in der .env.</p>
    </section>
  );
}
