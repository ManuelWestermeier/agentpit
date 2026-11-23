import { locale } from '../lib/i18n';
import { ExternalLink, LogOut, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useEscape } from '../lib/hooks';
import { act, useStore } from '../lib/store';
import { conn } from '../lib/ws';

export function LoginDialog() {
  const auth = useStore((s) => s.auth);
  const catalog = useStore((s) => s.catalog);
  const env = useStore((s) => s.hello?.env);
  const [code, setCode] = useState('');
  const close = useCallback(() => useStore.setState({ loginOpen: false }), []);
  useEscape(close);
  const st = auth?.status;
  const login = auth?.login;
  const running = login?.state === 'running';
  const acct = catalog?.account;

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-label="Claude-Konto">
        <h2>Claude-Konto</h2>
        {st?.loggedIn ? (
          <p>
            Angemeldet{st.email || acct?.email ? ` als ${st.email ?? acct?.email}` : ''} · {st.authMethod}
            {acct?.subscriptionType ? ` · Plan ${acct.subscriptionType}` : ''}
            {acct?.organization ? ` · ${acct.organization}` : ''}
            {st.loginExpiresAt ? ` · gültig bis ${new Date(st.loginExpiresAt).toLocaleDateString(locale)}` : ''}
          </p>
        ) : (
          <p>
            Die Anmeldung läuft über Claude Code selbst (<code>claude auth login</code>, Version {env?.claude.version ?? '?'}). Dein Browser öffnet
            die Login-Seite; falls nicht, nutze den Link unten. Erscheint dort ein Code, füge ihn hier ein.
          </p>
        )}
        {(st?.envApiKey || st?.envOAuthToken) && (
          <p className="faint">Hinweis: {st.envApiKey ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN'} ist gesetzt und hat Vorrang vor dem Login.</p>
        )}

        {running && (
          <>
            <div className="login-out">{login?.output.join('\n') || 'Starte …'}</div>
            {login?.url && (
              <a className="btn" href={login.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Login-Seite öffnen</a>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <input className="input mono" placeholder="Code von der Login-Seite (falls angezeigt)" value={code} onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) act(() => conn.call('auth.code', { code })).then(() => setCode('')); }} />
              <button className="btn primary" disabled={!code.trim()} onClick={() => act(() => conn.call('auth.code', { code })).then(() => setCode(''))}>Senden</button>
            </div>
          </>
        )}
        {login?.state === 'error' && login.error && <p className="err" style={{ marginTop: 10 }}>{login.error}</p>}

        <div className="modal-actions">
          <button className="btn ghost" onClick={() => act(() => conn.call('auth.status'))}><RefreshCw size={13} /> Status prüfen</button>
          <span style={{ flex: 1 }} />
          {running ? (
            <button className="btn" onClick={() => act(() => conn.call('auth.cancel'))}>Abbrechen</button>
          ) : st?.loggedIn ? (
            <button className="btn danger" onClick={() => act(() => conn.call('auth.logout'), 'Abgemeldet')}><LogOut size={13} /> Abmelden</button>
          ) : (
            <>
              <button className="btn" onClick={() => act(() => conn.call('auth.login', { method: 'console' }))} title="Abrechnung über API-Guthaben">Mit Console (API)</button>
              <button className="btn primary" onClick={() => act(() => conn.call('auth.login', { method: 'claudeai' }))}>Mit Claude-Abo anmelden</button>
            </>
          )}
          <button className="btn ghost" onClick={close}>Schließen</button>
        </div>
      </div>
    </div>
  );
}
