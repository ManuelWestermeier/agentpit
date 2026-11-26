import { Copy, Trash2, Users as UsersIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { act, useStore } from '../lib/store';
import { conn } from '../lib/ws';

interface User { name: string; browsers: string[]; createdAt: number; lastLogin: number | null }

/**
 * Admin: people who may only use a browser – each gets their own page /u/<name> with their own
 * identity (own cookies and logins), nothing else of the cockpit.
 */
export function UsersSection() {
  const profiles = useStore((s) => s.browsers?.profiles ?? []);
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const load = () => conn.call<{ users: User[] }>('users.list').then((r) => setUsers(r.users)).catch(() => {});
  useEffect(() => { load(); }, []);
  const done = (p: Promise<{ users: User[] } | undefined>) => p.then((r) => r && setUsers(r.users));
  const link = (n: string) => `${location.origin}/u/${n}/`;

  return (
    <section>
      <h3><UsersIcon size={14} /> Nutzer mit eigenem Browser</h3>
      <p className="muted">Jeder Nutzer meldet sich mit Name und Passwort an und sieht nur seinen Browser (eigene Cookies und Logins) – keine Projekte, keine Sessions.</p>
      {users.map((u) => (
        <div key={u.name} className="user-row">
          <div className="user-head">
            <b data-i18n-skip>{u.name}</b>
            <code data-i18n-skip>{link(u.name)}</code>
            <button className="btn ghost icon small" title="Link kopieren" onClick={() => navigator.clipboard.writeText(link(u.name)).then(() => { setCopied(u.name); setTimeout(() => setCopied(null), 1200); })}><Copy size={12} /></button>
            {copied === u.name && <small className="muted">kopiert</small>}
            <span className="spacer" />
            <button className="btn ghost small" onClick={() => { const p = prompt(`Neues Passwort für ${u.name}`); if (p) done(act(() => conn.call('users.password', { name: u.name, password: p }))); }}>Passwort …</button>
            <button className="btn ghost icon small danger" title="Nutzer löschen (die Browser-Identität bleibt)" onClick={() => confirm(`${u.name} löschen?`) && done(act(() => conn.call('users.remove', { name: u.name })))}><Trash2 size={12} /></button>
          </div>
          <div className="user-browsers">
            {profiles.map((p) => (
              <label key={p.id} className="check">
                <input type="checkbox" checked={u.browsers.includes(p.id)}
                  onChange={(e) => done(act(() => conn.call('users.browsers', { name: u.name, browsers: e.target.checked ? [...u.browsers, p.id] : u.browsers.filter((x) => x !== p.id) })))} />
                <span className="bdot" style={{ background: p.color }} />{p.name}
              </label>
            ))}
          </div>
        </div>
      ))}
      <form className="user-new" onSubmit={(e) => { e.preventDefault(); done(act(() => conn.call('users.create', { name, password: pw }))).then(() => { setName(''); setPw(''); }); }}>
        <input className="input" placeholder="Name, z. B. anna" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} autoCapitalize="none" required pattern="[a-z0-9][a-z0-9._\-]{1,31}" />
        <input className="input" type="password" placeholder="Passwort" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={4} />
        <button className="btn primary">Nutzer anlegen</button>
      </form>
      <p className="muted small">Neue Nutzer bekommen automatisch eine eigene Browser-Identität. Den Link schickst du ihnen selbst.</p>
    </section>
  );
}
