import { diffLines } from 'diff';
import { memo } from 'react';

const MAX_LINES = 600;

/** Line diff of an Edit: removed red, added green, unchanged context trimmed to 3 lines. */
export const DiffView = memo(function DiffView({ a, b }: { a: string; b: string }) {
  const parts = diffLines(a, b);
  const rows: { cls: string; text: string }[] = [];
  parts.forEach((p, idx) => {
    const lines = p.value.replace(/\n$/, '').split('\n');
    if (p.added) lines.forEach((l) => rows.push({ cls: 'add', text: `+ ${l}` }));
    else if (p.removed) lines.forEach((l) => rows.push({ cls: 'del', text: `- ${l}` }));
    else {
      const first = idx === 0, last = idx === parts.length - 1;
      if (lines.length <= 6) lines.forEach((l) => rows.push({ cls: 'ctx', text: `  ${l}` }));
      else {
        if (!first) lines.slice(0, 3).forEach((l) => rows.push({ cls: 'ctx', text: `  ${l}` }));
        rows.push({ cls: 'ctx', text: `  ⋯ ${lines.length - (first || last ? 3 : 6)} Zeilen` });
        if (!last) lines.slice(-3).forEach((l) => rows.push({ cls: 'ctx', text: `  ${l}` }));
      }
    }
  });
  return (
    <div className="diff">
      {rows.slice(0, MAX_LINES).map((r, i) => <div key={i} className={r.cls}>{r.text}</div>)}
      {rows.length > MAX_LINES && <div className="ctx">  … {rows.length - MAX_LINES} weitere Zeilen</div>}
    </div>
  );
});
