import { Copy, ExternalLink, GitBranch, KeyRound, LogOut, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useEscape } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import { conn } from '../lib/ws';
import { AccessSection } from './Access';
import { BypassSection } from './Permissions';
import { UsersSection } from './Users';
import { TunnelSection } from './Ops';
import { langSetting, setLang } from '../lib/i18n';

/** Claude login, GitHub login and remote-access status in one place. */
export function AccountsDialog() {
  const close = useCallback(() => useStore.setState({ loginOpen: false }), []);
  useEscape(close);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal wide" role="dialog" aria-label="Konten">
        <ClaudeSection />
        <hr className="modal-sep" />
        <GitHubSection />
        <hr className="modal-sep" />
        <AccessSection />
        <hr className="modal-sep" />
        <TunnelSection />
        <hr className="modal-sep" />
        <UsersSection />
        <hr className="modal-sep" />
        <BypassSection />
        <hr className="modal-sep" />
        <section>
          <label className="label" htmlFor="ui-lang">Sprache der Oberfläche</label>
          <select id="ui-lang" className="select" style={{ maxWidth: 260 }} defaultValue={langSetting()} onChange={(e) => setLang(e.target.value as 'de' | 'en' | 'auto')}>
            <option value="auto">Automatisch (Browser)</option>
            <option value="en" data-i18n-skip>English</option>
            <option value="de" data-i18n-skip>Deutsch</option>
          </select>
        </section>
        <div className="modal-actions"><button className="btn ghost" onClick={close}>Schließen</button></div>
      </div>
    </div>
  );
}

function ClaudeSection() {
  const auth = useStore((s) => s.auth);
  const catalog = useStore((s) => s.catalog);
  const env = useStore((s) => s.hello?.env);
  const [code, setCode] = useState('');
  const st = auth?.status;
  const login = auth?.login;
  const running = login?.state === 'running';
  const acct = catalog?.account;
  const submit = () => code.trim() && act(() => conn.call('auth.code', { code })).then(() => setCode(''));

  return (
    <section>
      <h3><KeyRound size={14} /> Claude</h3>
      {st?.loggedIn ? (
        <p className="small-text">
          Angemeldet{st.email || acct?.email ? ` als ${st.email ?? acct?.email}` : ''} · {st.authMethod}
          {acct?.subscriptionType ? ` · Plan ${acct.subscriptionType}` : ''}{acct?.organization ? ` · ${acct.organization}` : ''}
        </p>
      ) : (
        <p className="small-text">
          Anmeldung über Claude Code selbst (Version {env?.claude.version ?? '?'}). Öffne den Link – auch auf einem anderen Gerät möglich – und füge den angezeigten Code hier ein.
        </p>
      )}
      {(st?.envApiKey || st?.envOAuthToken) && <p className="faint small-text">{st.envApiKey ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN'} ist gesetzt und hat Vorrang.</p>}
      {running && (
        <>
          {login?.url ? <a className="btn" href={login.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Login-Seite öffnen</a> : <div className="login-out">{login?.output.join('\n') || 'Starte …'}</div>}
          <div className="row-inline">
            <input className="input mono" placeholder="Code von der Login-Seite" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
            <button className="btn primary" disabled={!code.trim()} onClick={submit}>Senden</button>
          </div>
        </>
      )}
      {login?.state === 'error' && login.error && <p className="err small-text">{login.error}</p>}
      <div className="row-inline">
        <button className="btn ghost small" onClick={() => act(() => conn.call('auth.status'))}><RefreshCw size={12} /> Prüfen</button>
        <span style={{ flex: 1 }} />
        {running ? <button className="btn small" onClick={() => act(() => conn.call('auth.cancel'))}>Abbrechen</button>
          : st?.loggedIn ? <button className="btn small danger" onClick={() => act(() => conn.call('auth.logout'), 'Abgemeldet')}><LogOut size={12} /> Abmelden</button>
          : <>
              <button className="btn small" onClick={() => act(() => conn.call('auth.login', { method: 'console' }))} title="Abrechnung über API-Guthaben">Console (API)</button>
              <button className="btn small primary" onClick={() => act(() => conn.call('auth.login', { method: 'claudeai' }))}>Mit Claude-Abo anmelden</button>
            </>}
      </div>
    </section>
  );
}

function GitHubSection() {
  const gh = useStore((s) => s.github);
  const [pat, setPat] = useState('');
  const [showPat, setShowPat] = useState(false);
  const st = gh?.status;
  const login = gh?.login;
  const running = login?.state === 'running';

  return (
    <section>
      <h3><GitBranch size={14} /> GitHub</h3>
      {!st?.installed ? (
        <p className="small-text">GitHub CLI (<code>gh</code>) fehlt auf dem Server. Installieren (Windows: <code>winget install GitHub.cli</code>, Linux: siehe README), dann „Prüfen“.</p>
      ) : st.loggedIn ? (
        <p className="small-text">Verbunden als <b>{st.login}</b>{st.name ? ` (${st.name})` : ''}. Git-Push/-Pull über HTTPS nutzt diese Anmeldung; Projekte lassen sich im Git-Tab direkt als Repository veröffentlichen.</p>
      ) : (
        <p className="small-text">Anmeldung per Gerätecode: Link öffnen, Code eingeben, bestätigen. Alternativ ein Fine-grained Token mit Zugriff auf „Contents“ und „Administration“ (für neue Repos).</p>
      )}
      {running && (
        <div className="device-code">
          {login?.code ? (
            <>
              <code className="big-code">{login.code}</code>
              <button className="btn ghost icon small" title="Kopieren" onClick={() => navigator.clipboard?.writeText(login.code!)}><Copy size={12} /></button>
              <a className="btn small primary" href={login.url ?? 'https://github.com/login/device'} target="_blank" rel="noreferrer"><ExternalLink size={12} /> github.com/login/device</a>
            </>
          ) : <span className="faint small-text">Fordere Code an …</span>}
        </div>
      )}
      {login?.state === 'error' && login.error && <p className="err small-text">{login.error}</p>}
      {showPat && !st?.loggedIn && (
        <div className="row-inline">
          <input className="input mono" type="password" autoComplete="off" placeholder="github_pat_…" value={pat} onChange={(e) => setPat(e.target.value)} />
          <button className="btn primary small" disabled={!pat.trim()} onClick={() => act(() => conn.call('github.token', { token: pat.trim() }), 'Mit GitHub verbunden').then(() => { setPat(''); setShowPat(false); })}>Speichern</button>
        </div>
      )}
      {st?.installed && (
        <div className="row-inline">
          <button className="btn ghost small" onClick={() => act(() => conn.call('github.status'))}><RefreshCw size={12} /> Prüfen</button>
          <span style={{ flex: 1 }} />
          {running ? <button className="btn small" onClick={() => act(() => conn.call('github.cancel'))}>Abbrechen</button>
            : st.loggedIn ? <button className="btn small danger" onClick={() => act(() => conn.call('github.logout'), 'Von GitHub abgemeldet')}><LogOut size={12} /> Abmelden</button>
            : <>
                <button className="btn small" onClick={() => setShowPat((v) => !v)}>Token</button>
                <button className="btn small primary" onClick={() => act(() => conn.call('github.login'))}>Mit GitHub anmelden</button>
              </>}
        </div>
      )}
      {!st?.installed && <div className="row-inline"><button className="btn ghost small" onClick={() => act(() => conn.call('github.status'))}><RefreshCw size={12} /> Prüfen</button></div>}
    </section>
  );
}
