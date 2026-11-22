import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useActive } from '../lib/hooks';
import { act } from '../lib/store';
import { conn } from '../lib/ws';

interface TermInfo { id: string; title: string; kind: string; alive?: boolean }

/** PTY terminals of the active project (PowerShell/bash or the interactive Claude Code TUI). */
export default function TerminalPanel() {
  const { project, runner } = useActive();
  const [terms, setTerms] = useState<TermInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    conn.call<TermInfo[]>('term.list', { projectId: project.id }).then((list) => {
      setTerms(list);
      setActive((a) => a ?? list[list.length - 1]?.id ?? null);
    }).catch(() => {});
  }, [project?.id]);

  if (!project) return null;

  const openTerm = async (kind: 'shell' | 'claude') => {
    const t = await act(() => conn.call<TermInfo>('term.open', { projectId: project.id, kind, sessionId: kind === 'claude' ? runner?.sessionId ?? project.lastSessionId : null, cols: 100, rows: 30 }));
    if (t) { setTerms((x) => [...x, t]); setActive(t.id); }
  };
  const close = async (id: string) => {
    await act(() => conn.call('term.close', { id }));
    setTerms((x) => x.filter((t) => t.id !== id));
    setActive((a) => (a === id ? null : a));
  };

  return (
    <div className="term">
      <div className="term-bar">
        {terms.map((t) => (
          <span key={t.id} style={{ display: 'inline-flex' }}>
            <button className={`chip${t.id === active ? ' active' : ''}`} onClick={() => setActive(t.id)}>{t.title}</button>
            <button className="btn ghost icon small" onClick={() => close(t.id)} title="Schließen"><X size={11} /></button>
          </span>
        ))}
        <button className="btn small" onClick={() => openTerm('shell')}><Plus size={12} /> Shell</button>
        <button className="btn small" onClick={() => openTerm('claude')} disabled={!!runner?.live} title={runner?.live ? 'Erst den Cockpit-Prozess beenden' : 'Session im interaktiven Claude Code öffnen'}>
          <Plus size={12} /> Claude TUI
        </button>
      </div>
      {active ? <TermView key={active} id={active} /> : <div className="empty">Öffnet ein Terminal im Projektordner – z. B. für ffmpeg-Tests oder die interaktive Claude-Oberfläche.</div>}
    </div>
  );
}

function TermView({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'IBM Plex Mono', Consolas, monospace",
      fontSize: 12.5,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#0f1214', foreground: '#e7e5dd', cursor: '#f0a73a', selectionBackground: 'rgba(240,167,58,0.3)' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    const doFit = () => {
      try {
        fit.fit();
        conn.send('term.resize', { id, cols: term.cols, rows: term.rows });
      } catch { /* hidden */ }
    };
    doFit();
    conn.call<string>('term.replay', { id }).then((data) => { if (data) term.write(data); }).catch(() => term.write('\r\n[Terminal beendet]\r\n'));
    const off = conn.onMessage((m) => {
      if (m.t === 'term' && m.id === id) term.write(m.data);
      if (m.t === 'term_exit' && m.id === id) term.write(`\r\n[Prozess beendet, Code ${m.exitCode}]\r\n`);
    });
    const sub = term.onData((data) => conn.send('term.input', { id, data }));
    const ro = new ResizeObserver(() => doFit());
    ro.observe(host.current!);
    term.focus();
    return () => { off(); sub.dispose(); ro.disconnect(); term.dispose(); };
  }, [id]);
  return <div className="term-host" ref={host} />;
}
