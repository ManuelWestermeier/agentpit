import { useCallback, useState } from 'react';
import { useEscape } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import type { BrowserProfile } from '../lib/types';
import { conn } from '../lib/ws';
import { InstallBox } from './BrowserView';

const COLORS = ['#8bb6db', '#74c49a', '#f0a73a', '#e5695e', '#c99ce0', '#d9c36a'];

export function ProfileDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const existing = useStore((s) => s.browsers?.profiles.find((p) => p.id === id));
  const status = useStore((s) => s.browsers?.status);
  const [f, setF] = useState(() => ({
    name: existing?.name ?? '', engine: existing?.engine ?? (status?.chrome ? 'chrome' : 'chromium'), headless: existing?.headless ?? status?.defaultHeadless ?? true,
    temporary: existing?.temporary ?? false, proxy: existing?.proxy ?? '', lang: existing?.lang ?? 'de-DE', startUrl: existing?.startUrl ?? '', color: existing?.color ?? COLORS[0],
  }));
  const [confirm, setConfirm] = useState('');
  const close = useCallback(onClose, [onClose]);
  useEscape(close);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));

  const save = async () => {
    const r = id
      ? await act(() => conn.call<BrowserProfile & { restartNeeded?: boolean }>('browsers.update', { id, patch: f }))
      : await act(() => conn.call<BrowserProfile>('browsers.create', { profile: f }));
    if (!r) return;
    if ((r as { restartNeeded?: boolean }).restartNeeded) useStore.getState().toast('info', 'Änderungen gelten nach Neustart des Browsers.');
    if (!id) useStore.setState({ profileView: r.id });
    onClose();
  };
  const remove = async () => { if (await act(() => conn.call('browsers.remove', { id })) !== undefined) onClose(); };
  const engines: [string, string, boolean][] = [
    ['chromium', 'Chromium (mitgeliefert)', !!status?.bundled],
    ['chrome', 'Google Chrome', !!status?.chrome],
    ['msedge', 'Microsoft Edge', !!status?.msedge],
  ];

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Browser-Identität">
        <h2>{id ? 'Identität bearbeiten' : 'Neue Browser-Identität'}</h2>
        <p>Eigenes Profil: Cookies, localStorage, Logins und Verlauf sind vollständig von anderen Identitäten getrennt. Fingerprint (Gerät, Grafikkarte) bleibt der dieses Rechners.</p>
        <div className="modal-row">
          <div><label className="label" htmlFor="pf-name">Name</label><input id="pf-name" className="input" value={f.name} maxLength={60} autoFocus onChange={(e) => set({ name: e.target.value })} placeholder="z. B. Kunde Huber" /></div>
          <div>
            <label className="label" htmlFor="pf-engine">Browser</label>
            <select id="pf-engine" className="select" value={f.engine} onChange={(e) => set({ engine: e.target.value as BrowserProfile['engine'] })}>
              {engines.map(([v, l, ok]) => <option key={v} value={v}>{l}{ok ? '' : ' – nicht installiert'}</option>)}
            </select>
          </div>
        </div>
        <div className="modal-row">
          <div><label className="label" htmlFor="pf-proxy">Proxy (optional)</label><input id="pf-proxy" className="input mono" value={f.proxy} onChange={(e) => set({ proxy: e.target.value })} placeholder="socks5://host:1080" /></div>
          <div><label className="label" htmlFor="pf-lang">Sprache</label><input id="pf-lang" className="input mono" value={f.lang} onChange={(e) => set({ lang: e.target.value })} placeholder="de-DE" /></div>
        </div>
        <label className="label" htmlFor="pf-start">Startseite</label>
        <input id="pf-start" className="input mono" value={f.startUrl} onChange={(e) => set({ startUrl: e.target.value })} placeholder="https://accounts.google.com" />
        <div style={{ display: 'flex', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
          <label className="check" title="Headless-Browser werden von manchen Logins (z. B. Google) abgelehnt"><input type="checkbox" checked={!f.headless} onChange={(e) => set({ headless: !e.target.checked })} /> {status?.virtualDisplay ? 'Echtes Browserfenster (virtuelles Display, beste Login-Kompatibilität)' : 'Echtes Browserfenster auf dem Server-Desktop'}</label>
          <label className="check"><input type="checkbox" checked={f.temporary} onChange={(e) => set({ temporary: e.target.checked })} /> Temporär (beim Beenden löschen)</label>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 12 }} role="radiogroup" aria-label="Farbe">
          {COLORS.map((c) => <button key={c} className={`swatch${f.color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => set({ color: c })} aria-label={c} />)}
        </div>
        {f.engine === 'chromium' && !status?.bundled && <InstallBox />}
        <p style={{ marginTop: 12 }}>Für Google-Logins Chrome bevorzugen und sichtbar starten, falls Google den Login blockiert. Anmeldedaten tippst du selbst – Claude tippt keine Passwörter ein.</p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Abbrechen</button>
          <button className="btn primary" disabled={!f.name.trim()} onClick={save}>{id ? 'Speichern' : 'Anlegen'}</button>
        </div>
        {id && (
          <div style={{ marginTop: 20, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
            <span className="label">Identität entfernen – Profil (inkl. Logins) wandert nach trash/</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input" placeholder={existing?.name} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              <button className="btn danger" disabled={confirm !== existing?.name} onClick={remove}>Entfernen</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
