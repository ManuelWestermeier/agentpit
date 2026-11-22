import { useStore } from '../lib/store';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`} role={t.level === 'error' ? 'alert' : 'status'}
          onClick={() => useStore.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
