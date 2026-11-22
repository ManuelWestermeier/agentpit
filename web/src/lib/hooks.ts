import { useEffect, useState } from 'react';
import { useStore } from './store';

/** Re-renders every `ms` milliseconds (for countdowns and elapsed times). */
export function useNow(ms = 1000, enabled = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
  return now;
}

/** Calls `fn` when Escape is pressed (dialogs). */
export function useEscape(fn: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') fn(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [fn]);
}

export function useActive() {
  const activeId = useStore((s) => s.activeId);
  const project = useStore((s) => s.projects.find((p) => p.id === s.activeId) ?? null);
  const runner = useStore((s) => (s.activeId ? s.runners[s.activeId] ?? null : null));
  return { activeId, project, runner };
}

export function previewUrl(base: string, projectId: string, path: string) {
  return `${base}/${encodeURIComponent(projectId)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export const ls = {
  get(k: string, d: string) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
