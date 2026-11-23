// Interface language. The UI is written in German; for every other language the visible text is translated
// from the dictionary in i18n-en.ts. That happens on the rendered DOM (text, title, placeholder, aria-label),
// so server messages (errors, hints, notes) are covered as well. Claude's output, prompts, code and logs are
// never touched (SKIP).
import EN from './i18n-en';

export type Lang = 'de' | 'en';
const KEY = 'cockpit.lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'de' || saved === 'en') return saved;
  } catch { /* storage blocked */ }
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => /^de\b/i.test(l ?? '')) ? 'de' : 'en';
}

export const lang: Lang = detect();
export const locale = lang === 'de' ? 'de-DE' : 'en-US';
document.documentElement.lang = lang;

export function setLang(l: Lang | 'auto') {
  try { if (l === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, l); } catch { /* ignore */ }
  location.reload();
}
export function langSetting(): Lang | 'auto' {
  try { const v = localStorage.getItem(KEY); return v === 'de' || v === 'en' ? v : 'auto'; } catch { return 'auto'; }
}

// ---- dictionary --------------------------------------------------------------------------------------------
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = new Map<string, string>();
const patterns: { prefix: string; re: RegExp; out: string }[] = [];
for (const [k, v] of Object.entries(EN as Record<string, string>)) {
  const key = norm(k);
  if (key.includes('{}')) {
    const parts = key.split('{}');
    patterns.push({ prefix: parts[0], re: new RegExp(`^${parts.map(esc).join('(.*?)')}$`, 's'), out: v });
  } else exact.set(key, v);
}
// most specific first
patterns.sort((a, b) => b.re.source.length - a.re.source.length);

const cache = new Map<string, string | null>();
function lookup(core: string, depth = 0): string | null {
  const hit = exact.get(core);
  if (hit !== undefined) return hit;
  if (depth > 1) return null;
  for (const p of patterns) {
    if (p.prefix && !core.startsWith(p.prefix)) continue;
    const m = core.match(p.re);
    if (!m) continue;
    let i = 0;
    return p.out.replace(/\{(\d*)\}/g, (_, n: string) => {
      const v = m[(n === '' ? i++ : Number(n)) + 1] ?? '';
      return lookup(norm(v), depth + 1) ?? v;
    });
  }
  return null;
}

/** Translates a German UI string (with surrounding whitespace kept). Unknown text comes back unchanged. */
export function t(s: string): string {
  if (lang === 'de' || !s) return s;
  return translate(s) ?? s;
}

function translate(s: string): string | null {
  if (!/[A-Za-zÄÖÜäöü]{2}/.test(s)) return null;
  let r = cache.get(s);
  if (r === undefined) {
    const core = norm(s);
    const out = lookup(core);
    r = out == null ? null : s.slice(0, s.length - s.trimStart().length) + out + s.slice(s.trimEnd().length);
    if (cache.size > 5000) cache.clear();
    cache.set(s, r);
  }
  return r;
}

// ---- DOM translation ---------------------------------------------------------------------------------------
const SKIP = 'pre, code, textarea, .md, .out-pre, .thinking, .xterm, .svc-log, .user-text, [data-i18n-skip]';
const ATTRS = ['title', 'placeholder', 'aria-label'];

function doText(n: Text) {
  const p = n.parentElement;
  // the queued badge inside a prompt is ours, the prompt text is not
  if (!p || (p.closest(SKIP) && !p.matches('.queued'))) return;
  const r = translate(n.data);
  if (r != null && r !== n.data) n.data = r;
}
function doEl(el: Element) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    const r = translate(v);
    if (r != null && r !== v) el.setAttribute(a, r);
  }
}
function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return doText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  // form fields: their value is the user's, their placeholder/title are ours
  if (el.matches('textarea, input')) return doEl(el);
  if (el.closest(SKIP) && !el.matches('.queued')) return;
  doEl(el);
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType !== Node.ELEMENT_NODE || !(n as Element).matches(SKIP)) return NodeFilter.FILTER_ACCEPT;
      if ((n as Element).matches('textarea, input')) doEl(n as Element);
      return NodeFilter.FILTER_REJECT;
    },
  });
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) doText(n as Text);
    else doEl(n as Element);
  }
}

export function startTranslator() {
  if (lang === 'de') return;
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') doText(m.target as Text);
      else if (m.type === 'attributes') doEl(m.target as Element);
      else m.addedNodes.forEach(walk);
    }
  });
  mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  walk(document.body);
}
