import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { _test as audioTest } from './audio.js';

const { Fmp4Splitter } = audioTest;

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'browser-ext');
/** Fixed by the public key in browser-ext/manifest.json. */
export const EXTENSION_ID = 'nhmebpdholodjglkjhkfomoipmebecle';

/**
 * Media bridge between remote viewers and a browser identity, through a small extension that the
 * cockpit loads into every identity (server/browser-ext). Works on Windows, macOS and Linux:
 *  - sound out: tab capture of the shown tab (it stops playing on the server's speakers) → Opus/WebM
 *  - microphone / camera in: getUserMedia of the page gets the viewer's microphone and camera
 *  - <select>: the dropdown opens as a list on the viewer's screen
 * The extension talks to the cockpit over ws://127.0.0.1:<port>/ext with a per-installation token.
 */
export class Bridge {
  constructor(ctx) {
    this.ctx = ctx;
    this.tokenFile = path.join(ctx.config.dataDir, '.ext-token');
    this.token = this.#token();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
    this.ids = new Map(); // identity → { sw, off, listeners: Map(client → 'webm'|'mp4'), header, aac, state, owner:{mic,cam} }
  }

  #token() {
    try { const t = fs.readFileSync(this.tokenFile, 'utf8').trim(); if (t.length >= 32) return t; } catch { /* new */ }
    const t = crypto.randomBytes(24).toString('base64url');
    fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
    fs.writeFileSync(this.tokenFile, t, { mode: 0o600 });
    return t;
  }

  #entry(id) {
    let e = this.ids.get(id);
    if (!e) this.ids.set(id, e = { sw: null, off: null, listeners: new Map(), header: [], aac: null, collecting: false, state: { mic: false, cam: false, remote: false }, owner: { mic: null, cam: null } });
    return e;
  }

  /** Extension folder for this identity (own config: id, port, token); flags for the browser start. */
  prepare(id) {
    const dir = path.join(this.ctx.config.dataDir, 'browser-ext', id);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(SRC)) {
      const src = path.join(SRC, f), dst = path.join(dir, f);
      const a = fs.readFileSync(src);
      let same = false;
      try { same = fs.readFileSync(dst).equals(a); } catch { /* missing */ }
      if (!same) fs.writeFileSync(dst, a);
    }
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ id, port: this.ctx.config.port, token: this.token }));
    return { dir, args: [`--load-extension=${dir}`, `--allowlisted-extension-id=${EXTENSION_ID}`] };
  }

  connected(id) { return !!this.ids.get(id)?.sw; }

  /** Why the extension is not there – the one thing the user can do about it. */
  #missing(id) {
    const p = this.ctx.browsers?.profiles.get(id);
    if (!this.ctx.browsers?.running.get(id)) return 'Browser läuft nicht.';
    if (p?.engine === 'chrome') return 'Google Chrome lädt die Medien-Brücke nicht (Erweiterungen per Startparameter gesperrt). Im Profil Engine „Chromium“ oder „Edge“ wählen.';
    return 'Medien-Brücke noch nicht verbunden – kurz warten oder den Browser einmal neu starten.';
  }

  /** WebSocket from the extension: only from 127.0.0.1, only with the token, only from our extension. */
  handleUpgrade(req, socket, head) {
    const u = new URL(req.url, 'http://x');
    const id = u.searchParams.get('id') ?? '';
    const role = u.searchParams.get('role');
    const ok = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
      && req.headers.origin === `chrome-extension://${EXTENSION_ID}`
      && (role === 'sw' || role === 'off')
      && this.ctx.browsers?.profiles.has(id)
      && crypto.timingSafeEqual(Buffer.from(crypto.createHash('sha256').update(u.searchParams.get('token') ?? '').digest()), Buffer.from(crypto.createHash('sha256').update(this.token).digest()));
    if (!ok) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.#attach(id, role, ws));
  }

  #attach(id, role, ws) {
    const e = this.#entry(id);
    try { e[role]?.close(); } catch { /* old one */ }
    e[role] = ws;
    ws.on('close', () => { if (e[role] === ws) e[role] = null; });
    ws.on('error', () => {});
    if (role === 'sw') {
      this.#send(e, { t: 'state', st: e.state });
      if (e.listeners.size) this.#send(e, { t: 'capture', on: true });
      this.ctx.browsers?.emitList?.();
    }
    ws.on('message', (data, binary) => {
      if (binary) return role === 'off' ? this.#audio(id, e, data) : null;
      let m;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.t === 'begin') { e.header = []; e.collecting = true; this.#restartAac(id, e); this.#toListeners(e, { t: 'bmedia', profileId: id, kind: 'audio', reset: true }); }
      else if (m.t === 'error') this.#toListeners(e, { t: 'bnotice', profileId: id, level: 'warn', text: String(m.text).slice(0, 300) });
      else if (m.t === 'select') this.#toViewers(id, { t: 'bselect', profileId: id, sel: { tab: m.tab, frame: m.frame, id: m.id }, title: String(m.title ?? '').slice(0, 120), index: m.index, options: (m.options ?? []).slice(0, 1000) });
    });
  }

  #send(e, m) { if (e.sw?.readyState === 1) e.sw.send(JSON.stringify(m)); }
  #toListeners(e, m, codec = null) { for (const [c, k] of e.listeners) if (!codec || k === codec) this.ctx.hub.send(c, m); }
  #toViewers(id, m) { for (const c of this.ctx.browsers?.running.get(id)?.viewers ?? []) this.ctx.hub.send(c, m); }

  /**
   * MediaRecorder output (Opus/WebM). The first piece carries the header. Viewers that cannot play
   * WebM (Safari, iPhone) get the same sound converted to AAC in fragmented MP4 by ffmpeg.
   */
  #audio(id, e, buf) {
    if (e.aac?.proc.stdin.writable) e.aac.proc.stdin.write(buf);
    const data = buf.toString('base64');
    if (e.collecting) {
      e.header.push(data);
      e.collecting = false; // the first chunk holds EBML header + tracks
      this.#toListeners(e, { t: 'bmedia', profileId: id, kind: 'audio', codec: 'webm', init: data }, 'webm');
      return;
    }
    this.#toListeners(e, { t: 'bmedia', profileId: id, kind: 'audio', codec: 'webm', data }, 'webm');
  }

  /** ffmpeg WebM/Opus → fMP4/AAC, only while an MP4 listener exists; restarted with every new recording. */
  #restartAac(id, e) {
    try { e.aac?.proc.kill(); } catch { /* gone */ }
    e.aac = null;
    if (![...e.listeners.values()].includes('mp4')) return;
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-f', 'webm', '-i', 'pipe:0',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-f', 'mp4', '-movflags', 'frag_every_frame+empty_moov+default_base_moof', '-frag_duration', '100000', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const aac = { proc };
    e.aac = aac;
    proc.on('error', () => {
      if (e.aac !== aac) return;
      e.aac = null;
      this.#toListeners(e, { t: 'bnotice', profileId: id, level: 'warn', text: 'Ton für dieses Gerät braucht ffmpeg auf dem Server – installieren (z. B. sudo apt install ffmpeg / winget install Gyan.FFmpeg).' }, 'mp4');
    });
    proc.stdin.on('error', () => {});
    const split = new Fmp4Splitter(
      (init) => this.#toListeners(e, { t: 'bmedia', profileId: id, kind: 'audio', codec: 'mp4', init: init.toString('base64') }, 'mp4'),
      (frag) => this.#toListeners(e, { t: 'bmedia', profileId: id, kind: 'audio', codec: 'mp4', data: frag.toString('base64') }, 'mp4'),
    );
    proc.stdout.on('data', (d) => split.push(d));
  }

  // ---------------------------------------------------------------- called by the cockpit

  /**
   * Sound of this identity to `client` ('webm' or 'mp4', whatever its browser plays). A new listener
   * restarts the recording, so everyone gets a clean start. Not connected yet (browser just starting)?
   * The listener waits; the recording starts as soon as the extension connects (#attach).
   */
  listen(id, client, on, codec = 'webm') {
    const e = this.#entry(id);
    if (!on) {
      e.listeners.delete(client);
      if (!e.listeners.size) { this.#send(e, { t: 'capture', on: false }); try { e.aac?.proc.kill(); } catch { /* gone */ } e.aac = null; }
      return { connected: !!e.sw };
    }
    if (!this.ctx.browsers?.running.has(id)) throw Object.assign(new Error('Browser läuft nicht.'), { user: true });
    e.listeners.set(client, codec === 'mp4' ? 'mp4' : 'webm');
    this.#send(e, { t: 'capture', on: true });
    if (!e.sw) this.#waitHint(id, client);
    return { connected: !!e.sw };
  }

  /** Still no extension after a while: this browser was started without it (older version) or Chrome blocks it. */
  #waitHint(id, client) {
    setTimeout(() => {
      const e = this.ids.get(id);
      if (!e || e.sw || (!e.listeners.has(client) && e.owner.mic !== client && e.owner.cam !== client)) return;
      const chrome = this.ctx.browsers?.profiles.get(id)?.engine === 'chrome';
      this.ctx.hub.send(client, { t: 'bnotice', profileId: id, level: 'warn', restart: !chrome,
        text: chrome ? this.#missing(id) : 'Ton und Mikrofon brauchen einen Neustart dieses Browsers (er lief schon vor dem Update).' });
    }, 8000).unref?.();
  }

  /** The shown tab changed: record that one instead. */
  tabChanged(id) {
    const e = this.ids.get(id);
    if (e?.listeners.size) this.#send(e, { t: 'capture', on: true });
  }

  setRemote(id, remote) {
    const e = this.#entry(id);
    if (e.state.remote === remote) return;
    e.state = { ...e.state, remote };
    this.#send(e, { t: 'state', st: e.state });
  }

  /** Viewer's microphone (kind 'mic') or camera ('cam') becomes the page's microphone/camera. */
  device(id, client, kind, on) {
    const e = this.#entry(id);
    if (on && !this.ctx.browsers?.running.has(id)) throw Object.assign(new Error('Browser läuft nicht.'), { user: true });
    if (on && !e.sw) this.#waitHint(id, client); // switched on now, delivered as soon as the extension connects
    if (on) e.owner[kind] = client;
    else if (e.owner[kind] === client || client == null) e.owner[kind] = null;
    else return;
    e.state = { ...e.state, [kind]: !!e.owner[kind] };
    this.#send(e, { t: 'state', st: e.state });
  }

  /** Binary from the viewer: [1|2][…] – only from the client that switched that device on. */
  data(id, client, type, payload) {
    const e = this.ids.get(id);
    const kind = type === 1 ? 'mic' : type === 2 ? 'cam' : null;
    if (!e?.sw || !kind || e.owner[kind] !== client || e.sw.bufferedAmount > 2 * 1024 * 1024) return;
    e.sw.send(Buffer.concat([Buffer.from([type]), payload]));
  }

  choose(id, sel, index) {
    const e = this.ids.get(id);
    if (!e || !sel) return;
    this.#send(e, { t: 'choose', tab: Number(sel.tab), frame: Number(sel.frame) || 0, id: String(sel.id), index: index == null ? null : Number(index) });
  }

  dropClient(client) {
    for (const [id, e] of this.ids) {
      if (e.listeners.has(client)) this.listen(id, client, false);
      for (const k of ['mic', 'cam']) if (e.owner[k] === client) this.device(id, client, k, false);
    }
  }
}
