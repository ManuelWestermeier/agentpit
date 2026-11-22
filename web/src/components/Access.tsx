import { Globe, KeyRound, LogOut, Monitor, ShieldCheck, Smartphone, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { fmtAgo } from '../lib/format';
import { act, useStore } from '../lib/store';
import { conn } from '../lib/ws';

const MIN = 4;

interface SecurityStatus {
  hasPassword: boolean;
  passwordAt: number | null;
  hosts: { host: string; origin?: string; addedAt?: number; fixed: boolean }[];
  sessions: { id: string; via: string; ip: string; host: string; ua: string; created: number; seen: number; current: boolean }[];
}

function checkNew(pw: string, pw2: string) {
  if (pw.length < MIN) return `Mindestens ${MIN} Zeichen.`;
  if (pw !== pw2) return 'Passwörter stimmen nicht überein.';
  return null;
}

/** Shown on first open until a password exists: the cockpit is never reachable without one. */
export function SetupPassword() {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = checkNew(pw, pw2);
    if (problem) { setErr(problem); return; }
    setBusy(true); setErr('');
    try {
      await conn.call('security.setPassword', { password: pw });
      const s = useStore.getState();
      if (s.hello) useStore.setState({ hello: { ...s.hello, config: { ...s.hello.config, hasPassword: true } } });
      s.toast('info', 'Passwort gesetzt – das Cockpit ist geschützt.');
    } catch (e2) { setErr((e2 as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="setup-bg">
      <form className="setup" onSubmit={submit}>
        <div className="setup-mark"><ShieldCheck size={18} /> Ersteinrichtung</div>
        <h2>Passwort für das Cockpit</h2>
        <p>Wer das Cockpit erreicht, kann über Claude Befehle auf diesem Rechner ausführen. Ab jetzt schützt dieses Passwort jeden Zugriff – lokal, über eine Domain oder einen Tunnel (Cloudflare, Dev Tunnels, Tailscale).</p>
        <label className="label" htmlFor="sp1">Neues Passwort</label>
        <input id="sp1" className="input" type="password" autoComplete="new-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
        <label className="label" htmlFor="sp2" style={{ marginTop: 10 }}>Wiederholen</label>
        <input id="sp2" className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        <div className="pw-meter"><i style={{ width: `${Math.min(100, (pw.length / 20) * 100)}%` }} className={pw.length >= MIN ? 'ok' : ''} /></div>
        {err && <p className="err small-text">{err}</p>}
        <button className="btn primary setup-btn" disabled={busy || !pw || !pw2}>{busy ? 'Speichere …' : 'Passwort setzen'}</button>
        <p className="faint small-text">Mindestens {MIN} Zeichen – am besten aus dem Passwortmanager. Vergessen? Auf dem Server <code>npm run set-password</code>.</p>
      </form>
    </div>
  );
}

/** Account dialog section: password, signed-in devices, trusted addresses. */
export function AccessSection() {
  const [st, setSt] = useState<SecurityStatus | null>(null);
  const [change, setChange] = useState(false);
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { conn.call<SecurityStatus>('security.status').then(setSt).catch(() => {}); }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const problem = checkNew(pw, pw2);
    if (problem) { setErr(problem); return; }
    try {
      setSt(await conn.call<SecurityStatus>('security.setPassword', { password: pw, current: cur }));
      setChange(false); setCur(''); setPw(''); setPw2(''); setErr('');
      useStore.getState().toast('info', 'Passwort geändert – alle anderen Geräte sind abgemeldet.');
    } catch (e2) { setErr((e2 as Error).message); }
  };
  const run = async (t: string, p: Record<string, unknown> = {}) => { const r = await act(() => conn.call<SecurityStatus>(t, p)); if (r) setSt(r); };
  const others = st?.sessions.filter((s) => !s.current).length ?? 0;

  return (
    <section>
      <h3><KeyRound size={14} /> Zugriff</h3>
      <p className="small-text">
        {st?.hasPassword ? <>Passwortschutz aktiv{st.passwordAt ? ` seit ${new Date(st.passwordAt).toLocaleDateString('de-DE')}` : ''}. </> : 'Noch kein Passwort. '}
        Neue Adressen (Domain, Tunnel) werden freigegeben, sobald du dich dort mit dem Passwort anmeldest.
      </p>

      {change ? (
        <form className="pw-form" onSubmit={save}>
          <input className="input" type="password" autoComplete="current-password" placeholder="Aktuelles Passwort" value={cur} onChange={(e) => setCur(e.target.value)} />
          <input className="input" type="password" autoComplete="new-password" placeholder={`Neues Passwort (min. ${MIN})`} value={pw} onChange={(e) => setPw(e.target.value)} />
          <input className="input" type="password" autoComplete="new-password" placeholder="Wiederholen" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          {err && <p className="err small-text">{err}</p>}
          <div className="row-inline" style={{ marginTop: 4 }}>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn ghost small" onClick={() => { setChange(false); setErr(''); }}>Abbrechen</button>
            <button className="btn primary small" disabled={!cur || !pw || !pw2}>Ändern</button>
          </div>
        </form>
      ) : st?.hasPassword && <button className="btn small" onClick={() => setChange(true)}>Passwort ändern</button>}

      {!!st?.hosts.length && (
        <>
          <div className="u-title acc-title">Freigegebene Adressen</div>
          {st.hosts.map((h) => (
            <div key={h.host} className="acc-row">
              <Globe size={13} className="faint" />
              <span className="mono ellipsis">{h.host}</span>
              <span className="faint small-text">{h.fixed ? '.env' : h.addedAt ? fmtAgo(h.addedAt) : ''}</span>
              {!h.fixed && <button className="btn ghost icon small" title="Freigabe entziehen (meldet Geräte dieser Adresse ab)" onClick={() => run('security.removeHost', { host: h.host })}><X size={12} /></button>}
            </div>
          ))}
        </>
      )}

      {!!st?.sessions.length && (
        <>
          <div className="u-title acc-title">Angemeldete Geräte</div>
          {st.sessions.map((s) => (
            <div key={s.id} className="acc-row">
              {/Mobile|Android|iPhone/i.test(s.ua) ? <Smartphone size={13} className="faint" /> : <Monitor size={13} className="faint" />}
              <span className="ellipsis" title={s.ua}>{device(s.ua)}{s.current && <b className="acc-cur"> · dieses Gerät</b>}</span>
              <span className="faint small-text ellipsis" title={`${s.ip} · ${s.host}`}>{s.via === 'link' ? 'Konsolen-Link' : 'Passwort'} · {fmtAgo(s.seen)}</span>
              {!s.current && <button className="btn ghost icon small" title="Abmelden" onClick={() => run('security.revoke', { id: s.id })}><LogOut size={12} /></button>}
            </div>
          ))}
          {others > 0 && <button className="btn ghost small" style={{ marginTop: 6 }} onClick={() => run('security.revokeOthers')}>Alle anderen Geräte abmelden</button>}
        </>
      )}
    </section>
  );
}

function device(ua: string) {
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Gerät';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${br} · ${os}` : os;
}
