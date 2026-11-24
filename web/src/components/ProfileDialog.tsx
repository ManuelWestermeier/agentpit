import { useCallback, useState } from 'react';
import { useEscape } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import type { BrowserProfile } from '../lib/types';
import { conn } from '../lib/ws';
import { InstallBox } from './BrowserView';
import { DEFAULT_STREAM, StreamControls } from './StreamSettings';

const COLORS = ['#8bb6db', '#74c49a', '#f0a73a', '#e5695e', '#c99ce0', '#d9c36a'];
const LANGS: [string, string][] = [
  ['de-DE', 'Deutsch (Deutschland)'], ['de-AT', 'Deutsch (Österreich)'], ['de-CH', 'Deutsch (Schweiz)'],
  ['en-US', 'Englisch (USA)'], ['en-GB', 'Englisch (UK)'], ['fr-FR', 'Französisch'], ['es-ES', 'Spanisch'], ['it-IT', 'Italienisch'],
  ['nl-NL', 'Niederländisch'], ['pl-PL', 'Polnisch'], ['pt-BR', 'Portugiesisch (Brasilien)'], ['tr-TR', 'Türkisch'],
  ['ru-RU', 'Russisch'], ['uk-UA', 'Ukrainisch'], ['ja-JP', 'Japanisch'], ['zh-CN', 'Chinesisch (vereinfacht)'],
];
const ZONES: string[] = (() => {
  try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); }
  catch { return ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/London', 'America/New_York', 'UTC']; }
})();

export function ProfileDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const existing = useStore((s) => s.browsers?.profiles.find((p) => p.id === id));
  const status = useStore((s) => s.browsers?.status);
  const [f, setF] = useState(() => ({
    name: existing?.name ?? '', engine: existing?.engine ?? (status?.chrome ? 'chrome' : 'chromium'), headless: existing?.headless ?? status?.defaultHeadless ?? false,
    temporary: existing?.temporary ?? false, proxy: existing?.proxy ?? '', lang: existing?.lang || 'de-DE', startUrl: existing?.startUrl ?? '', color: existing?.color ?? COLORS[0],
    languages: existing?.languages ?? '', timezone: existing?.timezone ?? '', colorScheme: existing?.colorScheme ?? 'auto',
    stream: { ...DEFAULT_STREAM, ...existing?.stream },
  }));
  const [customLang, setCustomLang] = useState(() => !LANGS.some(([v]) => v === (existing?.lang || 'de-DE')));
  const [confirm, setConfirm] = useState('');
  const close = useCallback(onClose, [onClose]);
  useEscape(close);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));

  const save = async () => {
    const r = id
      ? await act(() => conn.call<BrowserProfile & { restartNeeded?: boolean }>('browsers.update', { id, patch: f }))
      : await act(() => conn.call<BrowserProfile>('browsers.create', { profile: f }));
    if (!r) return;
    if ((r as { restartNeeded?: boolean }).restartNeeded) useStore.getState().toast('info', 'Browser, Sprache und Proxy gelten nach Neustart des Browsers – Zeitzone, Farbschema und Stream sofort.');
    if (!id) useStore.setState({ profileView: r.id });
    onClose();
  };
  const remove = async () => { if (await act(() => conn.call('browsers.remove', { id })) !== undefined) onClose(); };
  const engines: [string, string, boolean][] = [
    ['chromium', 'Chromium (mitgeliefert)', !!status?.bundled],
    ['chrome', 'Google Chrome', !!status?.chrome],
    ['msedge', 'Microsoft Edge', !!status?.msedge],
  ];
  const autoLangs = [...new Set([f.lang, f.lang.split('-')[0]])].join(', ');

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal--wide" role="dialog" aria-label="Browser-Identität">
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
          <div>
            <label className="label" htmlFor="pf-lang">Sprache</label>
            <select id="pf-lang" className="select" value={customLang ? '*' : f.lang} onChange={(e) => {
              if (e.target.value === '*') setCustomLang(true);
              else { setCustomLang(false); set({ lang: e.target.value }); }
            }}>
              {LANGS.map(([v, l]) => <option key={v} value={v}>{l} – {v}</option>)}
              <option value="*">Andere …</option>
            </select>
            {customLang && <input className="input mono" style={{ marginTop: 6 }} value={f.lang} onChange={(e) => set({ lang: e.target.value })} placeholder="z. B. sv-SE" aria-label="Sprachcode" />}
          </div>
          <div><label className="label" htmlFor="pf-start">Startseite</label><input id="pf-start" className="input mono" value={f.startUrl} onChange={(e) => set({ startUrl: e.target.value })} placeholder="https://accounts.google.com" /></div>
        </div>
        <div style={{ display: 'flex', gap: 18, marginTop: 4, flexWrap: 'wrap' }}>
          <label className="check" title="Unsichtbare (headless) Browser fallen bei Bot-Erkennung eher auf"><input type="checkbox" checked={!f.headless} onChange={(e) => set({ headless: !e.target.checked })} /> {status?.virtualDisplay ? 'Echtes Browserfenster (virtuelles Display, beste Login-Kompatibilität)' : 'Echtes Browserfenster auf dem Server-Desktop (empfohlen)'}</label>
          <label className="check"><input type="checkbox" checked={f.temporary} onChange={(e) => set({ temporary: e.target.checked })} /> Temporär (beim Beenden löschen)</label>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 12 }} role="radiogroup" aria-label="Farbe">
          {COLORS.map((c) => <button key={c} className={`swatch${f.color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => set({ color: c })} aria-label={c} />)}
        </div>

        <details className="adv">
          <summary>Stream &amp; Komprimierung <span className="muted">– {f.stream.mode === 'auto' ? 'Auto (nach Internetgeschwindigkeit)' : `Manuell, ${f.stream.format === 'png' ? 'PNG' : `JPEG ${f.stream.quality}`}, ${f.stream.maxWidth} px, ${f.stream.fps} fps`}</span></summary>
          <StreamControls idPrefix="pf-stream" value={f.stream} onChange={(stream) => set({ stream })} />
          <p className="stream-hint">Lässt sich auch live in der Browser-Ansicht über das Tacho-Symbol ändern.</p>
        </details>

        <details className="adv">
          <summary>Erweitert <span className="muted">– Sprachen, Zeitzone, Farbschema, Proxy</span></summary>
          <div className="modal-row">
            <div>
              <label className="label" htmlFor="pf-langs">Bevorzugte Sprachen (Accept-Language)</label>
              <input id="pf-langs" className="input mono" value={f.languages} onChange={(e) => set({ languages: e.target.value })} placeholder={`auto: ${autoLangs}`} />
            </div>
            <div>
              <label className="label" htmlFor="pf-tz">Zeitzone</label>
              <input id="pf-tz" className="input mono" list="pf-tz-list" value={f.timezone} onChange={(e) => set({ timezone: e.target.value })} placeholder="auto (System)" />
              <datalist id="pf-tz-list">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
            </div>
          </div>
          <div className="modal-row">
            <div>
              <label className="label" htmlFor="pf-scheme">Farbschema der Seiten</label>
              <select id="pf-scheme" className="select" value={f.colorScheme} onChange={(e) => set({ colorScheme: e.target.value as BrowserProfile['colorScheme'] })}>
                <option value="auto">Auto (System)</option>
                <option value="light">Hell</option>
                <option value="dark">Dunkel</option>
              </select>
            </div>
            <div><label className="label" htmlFor="pf-proxy">Proxy</label><input id="pf-proxy" className="input mono" value={f.proxy} onChange={(e) => set({ proxy: e.target.value })} placeholder="socks5://host:1080" /></div>
          </div>
          <p className="stream-hint">Tipp gegen Bot-Erkennung: Sprache und Zeitzone sollten zum Standort der IP-Adresse passen (ohne Proxy also „auto“ lassen).</p>
        </details>

        {id && status?.mcpCmd && (
          <details className="adv">
            <summary>In Claude Code verwenden <span className="muted">– auch ohne Cockpit</span></summary>
            <code className="mono" data-i18n-skip style={{ display: 'block', padding: '8px 10px', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 6, overflowX: 'auto', whiteSpace: 'nowrap', userSelect: 'all' }}>{`claude mcp add browser-${id} -- ${status.mcpCmd} ${id}`}</code>
            <p className="stream-hint">Claude Code (Terminal, Desktop, IDE) steuert dann genau diese Identität in einem sichtbaren Fenster – mit ihren Logins. Läuft das Cockpit, nutzen beide denselben Browser.</p>
          </details>
        )}

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
