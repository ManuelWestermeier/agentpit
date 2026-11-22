import type { StreamSettings, StreamStats } from '../lib/types';

export const DEFAULT_STREAM: StreamSettings = { mode: 'auto', quality: 70, maxWidth: 1920, fps: 30, format: 'jpeg' };

const WIDTHS = [3840, 2560, 1920, 1600, 1366, 1280, 1100, 1024, 900, 800, 720, 640, 480];
const FPS = [60, 30, 24, 20, 15, 10, 5, 2, 1];
const PRESETS: [string, string, Partial<StreamSettings>][] = [
  ['Beste Qualität', 'LAN / schnelles Internet', { quality: 90, maxWidth: 2560, fps: 30, format: 'jpeg' }],
  ['Ausgewogen', 'normales DSL / WLAN', { quality: 70, maxWidth: 1600, fps: 24, format: 'jpeg' }],
  ['Datensparend', 'langsames Internet', { quality: 45, maxWidth: 1100, fps: 15, format: 'jpeg' }],
  ['Mobilfunk', 'unterwegs, wenig Daten', { quality: 30, maxWidth: 800, fps: 10, format: 'jpeg' }],
];

/** Stream compression controls – used in the profile dialog and live in the browser view. */
export function StreamControls({ value, onChange, idPrefix }: { value: StreamSettings; onChange: (s: StreamSettings) => void; idPrefix: string }) {
  const set = (p: Partial<StreamSettings>) => onChange({ ...value, ...p });
  const manual = value.mode === 'manual';
  return (
    <div className="stream-ctl">
      <div className="seg" role="radiogroup" aria-label="Stream-Modus">
        <button type="button" role="radio" aria-checked={!manual} className={!manual ? 'on' : ''} onClick={() => set({ mode: 'auto' })}>Auto</button>
        <button type="button" role="radio" aria-checked={manual} className={manual ? 'on' : ''} onClick={() => set({ mode: 'manual' })}>Manuell</button>
      </div>
      {!manual && <p className="stream-hint">Qualität, Auflösung und Bildrate passen sich laufend an deine Internetgeschwindigkeit an: Ruckelt es, wird reduziert, ist die Leitung frei, wird wieder hochgeregelt.</p>}
      {manual && (
        <>
          <div className="stream-presets">
            {PRESETS.map(([name, hint, p]) => (
              <button type="button" key={name} className="btn small" title={hint} onClick={() => set(p)}>{name}</button>
            ))}
          </div>
          <label className="label" htmlFor={`${idPrefix}-q`}>JPEG-Qualität: <b>{value.quality}</b>{value.format === 'png' && ' (bei PNG ohne Wirkung)'}</label>
          <input id={`${idPrefix}-q`} type="range" min={10} max={100} step={1} value={value.quality} disabled={value.format === 'png'} onChange={(e) => set({ quality: Number(e.target.value) })} className="range" />
          <div className="modal-row" style={{ gridTemplateColumns: '1fr 1fr 1fr', marginTop: 8 }}>
            <div>
              <label className="label" htmlFor={`${idPrefix}-w`}>Max. Breite</label>
              <select id={`${idPrefix}-w`} className="select" value={value.maxWidth} onChange={(e) => set({ maxWidth: Number(e.target.value) })}>
                {[...new Set([...WIDTHS, value.maxWidth])].sort((a, b) => b - a).map((w) => <option key={w} value={w}>{w} px</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor={`${idPrefix}-f`}>Max. Bildrate</label>
              <select id={`${idPrefix}-f`} className="select" value={value.fps} onChange={(e) => set({ fps: Number(e.target.value) })}>
                {[...new Set([...FPS, value.fps])].sort((a, b) => b - a).map((f) => <option key={f} value={f}>{f} fps</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor={`${idPrefix}-fmt`}>Format</label>
              <select id={`${idPrefix}-fmt`} className="select" value={value.format} onChange={(e) => set({ format: e.target.value as StreamSettings['format'] })}>
                <option value="jpeg">JPEG (komprimiert)</option>
                <option value="png">PNG (verlustfrei, sehr viele Daten)</option>
              </select>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Live numbers of the running stream. */
export function StreamStatsView({ stats }: { stats: StreamStats | null }) {
  if (!stats) return <p className="stream-hint">Noch keine Messwerte … (kommen alle 1,5 s, solange sich das Bild bewegt)</p>;
  const pct = stats.levels > 1 ? Math.round(((stats.levels - 1 - stats.level) / (stats.levels - 1)) * 100) : 100;
  return (
    <div className="stream-stats">
      <div><span>Bildrate</span><b>{stats.fps} / {stats.fpsLimit} fps</b></div>
      <div><span>Datenrate</span><b>{stats.kbps >= 1000 ? `${(stats.kbps / 1000).toFixed(1)} Mbit/s` : `${stats.kbps} kbit/s`}</b></div>
      <div><span>Bildgröße</span><b>{stats.frameKb} KB</b></div>
      <div><span>Auflösung</span><b>≤ {stats.maxWidth} px</b></div>
      <div><span>Qualität</span><b>{stats.format === 'png' ? 'PNG' : `JPEG ${stats.quality}`}</b></div>
      <div><span>Übersprungen</span><b className={stats.skipped ? 'warn' : ''}>{stats.skipped}</b></div>
      <div title="Zeit vom Senden eines Bildes bis es bei dir angezeigt ist"><span>Latenz</span><b>{stats.rtt == null ? '–' : `${stats.rtt} ms`}</b></div>
      <div title="Anteil der Latenz, der durch Stau entsteht (0 = Leitung frei)"><span>Stau</span><b className={(stats.queue ?? 0) > 150 ? 'warn' : ''}>{stats.queue == null ? '–' : `${stats.queue} ms`}</b></div>
      {stats.mode === 'auto' && (
        <div className="stream-level" title="Auto-Stufe: voll = beste Qualität">
          <span>Auto-Stufe</span>
          <div className="stream-bar"><i style={{ width: `${pct}%` }} /></div>
        </div>
      )}
    </div>
  );
}
