import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UserError, stripAnsi } from './util.js';

const QUICK_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

/** Official single-file build for this machine (Linux, Windows); macOS goes through Homebrew. */
function assetName() {
  const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[process.arch];
  if (!arch) return null;
  if (process.platform === 'linux') return `cloudflared-linux-${arch}`;
  if (process.platform === 'win32') return `cloudflared-windows-${arch === 'arm64' ? 'amd64' : arch}.exe`;
  return null;
}

/**
 * Remote access through Cloudflare Tunnel – no open port, no router setup, TLS end to end to
 * Cloudflare and an encrypted tunnel from there to this machine.
 *  - "quick": `cloudflared tunnel --url …` – no account, random https://….trycloudflare.com address
 *    (new on every start; good for trying, rate-limited by Cloudflare).
 *  - "token": a named tunnel from the Cloudflare dashboard (own domain, fixed address); the token comes
 *    from CLOUDFLARE_TUNNEL_TOKEN in .env and is handed over via the environment, never the command line.
 * The cockpit itself still only listens on 127.0.0.1; the login protects every request coming in.
 */
export class Tunnel extends EventEmitter {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.binDir = path.join(ctx.config.dataDir, 'tools'); // never <home>/bin: in a git checkout that is the package's own bin/
    this.state = { status: 'off', mode: null, url: null, error: null, lines: [], installed: !!this.bin() };
    this.proc = null;
    this.want = false;
    this.restarts = 0;
  }

  bin() {
    const own = path.join(this.binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    if (fs.existsSync(own)) return own;
    // pre-release 1.4.0 put it into <home>/bin – in a git checkout that is the package's bin/: move it out
    const legacy = path.join(this.ctx.config.home, 'bin', path.basename(own));
    if (fs.existsSync(legacy)) {
      try { fs.mkdirSync(this.binDir, { recursive: true }); fs.renameSync(legacy, own); return own; } catch { return legacy; } // still running → next start
    }
    const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      for (const ext of exts) { const f = path.join(dir, `cloudflared${ext}`); if (dir && fs.existsSync(f)) return f; }
    }
    // winget installs here without touching PATH of this process
    if (process.platform === 'win32') {
      const f = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'cloudflared', 'cloudflared.exe');
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  snapshot() { return { ...this.state, lines: this.state.lines.slice(-12), installed: !!this.bin(), hasToken: !!process.env.CLOUDFLARE_TUNNEL_TOKEN }; }

  #set(patch) {
    Object.assign(this.state, patch);
    this.emit('change');
  }

  #log(text) {
    for (const l of stripAnsi(String(text)).split(/\r?\n/)) {
      const line = l.trim();
      if (!line) continue;
      this.state.lines.push(line.slice(0, 300));
      const m = QUICK_RE.exec(line);
      if (m && this.state.mode === 'quick' && this.state.url !== m[0]) { this.#set({ url: m[0] }); this.#announce(); }
      if (/Registered tunnel connection/i.test(line) && this.state.status !== 'on') { this.restarts = 0; this.#set({ status: 'on', error: null }); this.#announce(); }
    }
    if (this.state.lines.length > 60) this.state.lines.splice(0, this.state.lines.length - 60);
    this.emit('change');
  }

  #announce() {
    if (this.state.status === 'on' && this.state.url) console.log(`  Fernzugriff (Cloudflare Tunnel): ${this.state.url}`);
  }

  /** Download cloudflared into <home>/bin (Linux/Windows), Homebrew on macOS. */
  async install() {
    if (this.bin()) return this.bin();
    const name = assetName();
    if (!name) {
      if (process.platform === 'darwin') throw new UserError('Auf macOS: brew install cloudflared');
      throw new UserError(`Kein cloudflared für ${process.platform}-${process.arch}`);
    }
    this.#set({ status: 'installing', error: null });
    await fsp.mkdir(this.binDir, { recursive: true });
    const target = path.join(this.binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    const tmp = `${target}.download`;
    try {
      const r = await fetch(RELEASE + name, { redirect: 'follow' });
      if (!r.ok || !r.body) throw new Error(`Download fehlgeschlagen (${r.status})`);
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp, { mode: 0o755 }));
      await fsp.rename(tmp, target);
      this.#log(`cloudflared installiert: ${target}`);
      this.#set({ status: 'off' });
      return target;
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      this.#set({ status: 'error', error: e.message });
      throw new UserError(e.message);
    }
  }

  async start(mode = process.env.CLOUDFLARE_TUNNEL_TOKEN ? 'token' : 'quick') {
    if (this.proc) return this.snapshot();
    if (mode === 'token' && !process.env.CLOUDFLARE_TUNNEL_TOKEN) throw new UserError('CLOUDFLARE_TUNNEL_TOKEN fehlt in der .env (Cloudflare → Zero Trust → Networks → Tunnels → Token).');
    const bin = this.bin() ?? await this.install();
    this.want = true;
    const port = this.ctx.config.port;
    const args = mode === 'token'
      ? ['tunnel', '--no-autoupdate', 'run']
      : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`]; // Host stays the public name: the login learns and trusts it
    // the token stays out of the process list (ps) – cloudflared reads TUNNEL_TOKEN itself
    const env = { ...process.env, ...(mode === 'token' ? { TUNNEL_TOKEN: process.env.CLOUDFLARE_TUNNEL_TOKEN } : {}) };
    this.#set({ status: 'starting', mode, url: mode === 'token' ? this.ctx.config.publicUrls[0] ?? null : null, error: null, lines: [] });
    const proc = spawn(bin, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdout.on('data', (d) => this.#log(d));
    proc.stderr.on('data', (d) => this.#log(d));
    proc.on('error', (e) => this.#set({ status: 'error', error: e.message }));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (!this.want) return this.#set({ status: 'off', url: null });
      // dropped (network, Cloudflare restart): reconnect with backoff
      const wait = Math.min(60_000, 2000 * 2 ** this.restarts++);
      this.#set({ status: 'error', error: `cloudflared beendet (Code ${code}) – neuer Versuch in ${Math.round(wait / 1000)} s` });
      setTimeout(() => { if (this.want && !this.proc) this.start(mode).catch(() => {}); }, wait).unref?.();
    });
    return this.snapshot();
  }

  stop() {
    this.want = false;
    const p = this.proc;
    this.proc = null;
    try { p?.kill(); } catch { /* gone */ }
    this.#set({ status: 'off', url: null });
  }
}
