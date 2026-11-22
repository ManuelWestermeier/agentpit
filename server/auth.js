import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { claudeBinary } from './environment.js';
import { stripAnsi } from './util.js';

const URL_RE = /https:\/\/[^\s"'<>]+/g;

/**
 * Wraps `claude auth status|login|logout` of the bundled CLI.
 * Login runs without a TTY: the CLI opens the browser itself and either receives the
 * OAuth callback on localhost or waits for the code that the user pastes into the UI.
 */
export class Auth extends EventEmitter {
  constructor({ config }) {
    super();
    this.config = config;
    this.status = null;
    this.login = { state: 'idle', output: [], url: null, startedAt: 0, error: null };
    this.proc = null;
  }

  get bin() { return claudeBinary(this.config); }

  refresh() {
    return new Promise((resolve) => {
      execFile(this.bin, ['auth', 'status', '--json'], { timeout: 20_000, windowsHide: true }, (err, stdout) => {
        // exits with 1 when logged out but still prints JSON
        let status = null;
        try { status = JSON.parse(String(stdout).trim()); } catch { /* not JSON */ }
        if (!status) status = { loggedIn: false, authMethod: 'unknown', error: err ? err.message : 'Keine Antwort' };
        if (process.env.ANTHROPIC_API_KEY) status.envApiKey = true;
        if (process.env.CLAUDE_CODE_OAUTH_TOKEN) status.envOAuthToken = true;
        this.status = status;
        this.emit('change');
        resolve(status);
      });
    });
  }

  snapshot() {
    return { status: this.status, login: { ...this.login, output: this.login.output.slice(-40) } };
  }

  startLogin(method = 'claudeai') {
    if (this.proc) return;
    const args = ['auth', 'login', method === 'console' ? '--console' : '--claudeai'];
    this.login = { state: 'running', output: [], url: null, startedAt: Date.now(), error: null };
    const proc = spawn(this.bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    const onData = (chunk) => {
      const text = stripAnsi(chunk.toString('utf8'));
      for (const line of text.split(/\r?\n/)) {
        const l = line.trim();
        if (!l) continue;
        this.login.output.push(l);
        const urls = l.match(URL_RE);
        if (urls) this.login.url = urls[urls.length - 1];
      }
      if (this.login.output.length > 200) this.login.output.splice(0, this.login.output.length - 200);
      this.emit('change');
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => {
      this.login.state = 'error';
      this.login.error = e.message;
      this.proc = null;
      this.emit('change');
    });
    proc.on('exit', async (code) => {
      this.proc = null;
      if (this.login.state === 'running') {
        this.login.state = code === 0 ? 'done' : 'error';
        if (code !== 0) this.login.error = `Login beendet (Code ${code})`;
      }
      await this.refresh();
    });
    // Without input the CLI waits for the browser callback; give up after 10 minutes.
    setTimeout(() => { if (this.proc === proc) this.cancelLogin('Zeitüberschreitung'); }, 10 * 60_000).unref();
    this.emit('change');
  }

  submitCode(code) {
    const c = String(code ?? '').trim();
    if (!this.proc || !c || c.length > 4096 || /[\r\n]/.test(c)) return false;
    this.proc.stdin.write(`${c}\n`);
    this.login.output.push('Code übermittelt …');
    this.emit('change');
    return true;
  }

  cancelLogin(reason = 'Abgebrochen') {
    if (this.proc) {
      this.login.state = 'error';
      this.login.error = reason;
      this.proc.kill();
      this.proc = null;
      this.emit('change');
    }
  }

  logout() {
    return new Promise((resolve) => {
      execFile(this.bin, ['auth', 'logout'], { timeout: 20_000, windowsHide: true }, async () => {
        resolve(await this.refresh());
      });
    });
  }
}
