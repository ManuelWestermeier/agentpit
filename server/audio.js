import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const run = (cmd, args, timeout = 8000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
});
const onPath = (bin) => (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));

/** Sound of one identity → AAC in fragmented MP4: plays in every browser's MediaSource (also iOS ManagedMediaSource). */
const OUT_RATE = 48_000;
/** Microphone from the viewer: 16-bit mono PCM at 24 kHz (≈ 384 kbit/s – speech-clear, light on phones). */
export const MIC_RATE = 24_000;

/**
 * Splits an fMP4 byte stream into the init segment (ftyp+moov) and media fragments (moof+mdat),
 * so a viewer that joins later can start cleanly at a fragment.
 */
class Fmp4Splitter {
  constructor(onInit, onFragment) {
    this.buf = Buffer.alloc(0);
    this.init = [];
    this.frag = [];
    this.onInit = onInit;
    this.onFragment = onFragment;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 8) {
      let size = this.buf.readUInt32BE(0);
      const type = this.buf.toString('latin1', 4, 8);
      if (size === 1) { if (this.buf.length < 16) return; size = Number(this.buf.readBigUInt64BE(8)); }
      if (size < 8 || size > 64 * 1024 * 1024) { this.buf = Buffer.alloc(0); return; } // garbage – resync on next start
      if (this.buf.length < size) return;
      const box = this.buf.subarray(0, size);
      this.buf = this.buf.subarray(size);
      if (type === 'ftyp' || type === 'moov') {
        this.init.push(Buffer.from(box));
        if (type === 'moov') this.onInit(Buffer.concat(this.init));
      } else if (type === 'moof') {
        this.frag = [Buffer.from(box)];
      } else if (type === 'mdat' && this.frag.length) {
        this.frag.push(Buffer.from(box));
        this.onFragment(Buffer.concat(this.frag));
        this.frag = [];
      }
    }
  }
}

/**
 * Sound for remote browsers on Linux servers (PulseAudio or PipeWire with its pulse layer).
 *
 * Every identity gets its own virtual sound card before its browser starts:
 *  - output "cockpit_<id>" (null sink) – what the identity plays; its monitor is encoded and streamed
 *    to the viewers who switched sound on
 *  - microphone "cockpit_mic_<id>" (pipe source) – fed with the viewer's microphone
 * The browser is pointed at them with PULSE_SINK / PULSE_SOURCE. For the website this is an ordinary
 * sound card and microphone: no injected script, no fake media API, nothing to detect – and no identity
 * hears another one.
 * Windows/macOS: not available (the browser plays on the machine's own speakers).
 */
export class Audio {
  constructor(ctx) {
    this.ctx = ctx;
    this.ready = null;   // Promise<boolean>
    this.streams = new Map(); // id → { proc, listeners:Set, init:Buffer|null }
    this.mics = new Map();    // id → { fifo, ws: WriteStream, owner, lastAt }
  }

  /** Is a pulse server reachable (starts a per-user daemon when only the binary is there)? */
  available() {
    this.ready ??= (async () => {
      if (process.platform !== 'linux' || !onPath('pactl') || !onPath('ffmpeg')) return false;
      if (await run('pactl', ['info'])) return true;
      if (onPath('pulseaudio')) {
        await run('pulseaudio', ['--start', '--exit-idle-time=-1', '--log-target=syslog'], 10_000);
        return !!(await run('pactl', ['info']));
      }
      return false;
    })();
    return this.ready;
  }

  async status() {
    const pulse = await this.available();
    return { available: true, pulse };
  }

  sink(id) { return `cockpit_${id.replace(/[^a-z0-9]/g, '_')}`; }
  source(id) { return `cockpit_mic_${id.replace(/[^a-z0-9]/g, '_')}`; }
  fifo(id) { return path.join(this.ctx.store.p('audio'), `${id}.mic`); }

  /** Creates the identity's sound card (idempotent) and returns the env for its browser process. */
  async prepare(id, name) {
    if (!(await this.available())) return {};
    const sinks = await run('pactl', ['list', 'short', 'sinks']) ?? '';
    const sources = await run('pactl', ['list', 'short', 'sources']) ?? '';
    const sink = this.sink(id), source = this.source(id);
    const label = String(name ?? id).replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40) || id;
    if (!sinks.split('\n').some((l) => l.split('\t')[1] === sink)) {
      await run('pactl', ['load-module', 'module-null-sink', `sink_name=${sink}`, `sink_properties=device.description="${label.replace(/ /g, '_')}"`]);
    }
    if (!sources.split('\n').some((l) => l.split('\t')[1] === source)) {
      fs.mkdirSync(path.dirname(this.fifo(id)), { recursive: true });
      await run('pactl', ['load-module', 'module-pipe-source', `source_name=${source}`, `file=${this.fifo(id)}`, 'format=s16le', `rate=${MIC_RATE}`, 'channels=1',
        `source_properties=device.description="Mikrofon_${label.replace(/ /g, '_')}"`]);
    }
    return { PULSE_SINK: sink, PULSE_SOURCE: source };
  }

  /** Identity deleted: remove its sound card. */
  async drop(id) {
    if (!(await this.available())) return;
    this.#stopStream(id);
    this.micOff(id);
    const mods = await run('pactl', ['list', 'short', 'modules']) ?? '';
    for (const l of mods.split('\n')) {
      if (l.includes(`sink_name=${this.sink(id)}`) || l.includes(`source_name=${this.source(id)}`)) await run('pactl', ['unload-module', l.split('\t')[0]]);
    }
  }

  // ---------------------------------------------------------------- sound → viewers

  async listen(id, client, on) {
    if (!on) {
      const s = this.streams.get(id);
      if (!s) return;
      s.listeners.delete(client);
      if (!s.listeners.size) this.#stopStream(id);
      return;
    }
    if (!(await this.available())) throw Object.assign(new Error(process.platform === 'linux' ? 'Kein PulseAudio/PipeWire – sudo apt install pulseaudio-utils pulseaudio' : 'Ton-Brücke nicht verbunden – Browser einmal neu starten.'), { user: true });
    let s = this.streams.get(id);
    if (!s) s = this.#startStream(id);
    s.listeners.add(client);
    if (s.init) this.ctx.hub.send(client, { t: 'bmedia', profileId: id, kind: 'audio', init: s.init.toString('base64') });
  }

  dropClient(client) {
    for (const [id, s] of this.streams) if (s.listeners.has(client)) this.listen(id, client, false);
    for (const [id, m] of this.mics) if (m.owner === client) this.micOff(id);
  }

  #startStream(id) {
    // low latency: tiny probe, 100 ms fragments, no buffering in ffmpeg
    const args = ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-f', 'pulse', '-fragment_size', '1920', '-i', `${this.sink(id)}.monitor`,
      '-ac', '2', '-ar', String(OUT_RATE), '-c:a', 'aac', '-b:a', '128k',
      '-f', 'mp4', '-movflags', 'frag_every_frame+empty_moov+default_base_moof', '-frag_duration', '100000', 'pipe:1'];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const s = { proc, listeners: new Set(), init: null };
    const send = (msg) => { for (const c of s.listeners) this.ctx.hub.send(c, msg); };
    const split = new Fmp4Splitter(
      (init) => { s.init = init; send({ t: 'bmedia', profileId: id, kind: 'audio', init: init.toString('base64') }); },
      (frag) => send({ t: 'bmedia', profileId: id, kind: 'audio', data: frag.toString('base64') }),
    );
    proc.stdout.on('data', (d) => split.push(d));
    proc.stderr.on('data', (d) => console.warn(`[audio] ${id}: ${String(d).trim().slice(0, 200)}`));
    proc.on('exit', () => { if (this.streams.get(id) === s) { this.streams.delete(id); send({ t: 'bmedia', profileId: id, kind: 'audio', ended: true }); } });
    this.streams.set(id, s);
    return s;
  }

  #stopStream(id) {
    const s = this.streams.get(id);
    this.streams.delete(id);
    try { s?.proc.kill(); } catch { /* gone */ }
  }

  // ---------------------------------------------------------------- viewer microphone → identity

  async micOn(id, client) {
    if (!(await this.available())) throw Object.assign(new Error(process.platform === 'linux' ? 'Kein PulseAudio/PipeWire – sudo apt install pulseaudio-utils pulseaudio' : 'Ton-Brücke nicht verbunden – Browser einmal neu starten.'), { user: true });
    await this.prepare(id, this.ctx.browsers?.profiles.get(id)?.name);
    const cur = this.mics.get(id);
    if (cur && cur.owner !== client) cur.ws.destroy(); // newest speaker wins
    if (cur?.owner === client) return;
    const ws = fs.createWriteStream(this.fifo(id), { flags: 'a' });
    ws.on('error', () => this.micOff(id));
    this.mics.set(id, { ws, owner: client, lastAt: Date.now() });
  }

  /** PCM s16le mono MIC_RATE from the viewer. Only the client that switched the mic on may feed it. */
  micData(id, client, pcm) {
    const m = this.mics.get(id);
    if (!m || m.owner !== client) return;
    m.lastAt = Date.now();
    if (m.ws.writableLength < MIC_RATE * 2) m.ws.write(pcm); // > 1 s behind → drop instead of lagging
  }

  micOff(id) {
    const m = this.mics.get(id);
    this.mics.delete(id);
    try { m?.ws.end(); } catch { /* gone */ }
  }

  stopAll() {
    for (const id of [...this.streams.keys()]) this.#stopStream(id);
    for (const id of [...this.mics.keys()]) this.micOff(id);
  }
}

export const _test = { Fmp4Splitter };
