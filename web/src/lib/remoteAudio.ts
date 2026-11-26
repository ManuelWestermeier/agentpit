import { useEffect, useRef, useState } from 'react';
import { conn } from './ws';

const MIC_RATE = 24_000; // server/audio.js MIC_RATE
const MIME = 'audio/mp4; codecs="mp4a.40.2"'; // Linux/PulseAudio path
const WEBM = 'audio/webm; codecs="opus"'; // tab capture through the extension
const SOUND_KEY = 'cockpit.sound';

type MS = typeof MediaSource;
const MediaSourceImpl: MS | undefined = (window as unknown as { ManagedMediaSource?: MS }).ManagedMediaSource ?? window.MediaSource;
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Sound of the remote browser (fMP4/AAC fragments over the WebSocket → MediaSource) and the
 * viewer's microphone into it (PCM 24 kHz mono, binary frames). Latency is kept short: when the
 * buffer runs ahead, playback jumps to the live edge instead of drifting behind the picture.
 */
export function useRemoteAudio(profileId: string) {
  // sound is on by default (remembered per device); browsers only play after a click, so a blocked
  // start waits for the first click or key into the page
  const [sound, setSoundState] = useState(() => { try { return localStorage.getItem(SOUND_KEY) !== '0'; } catch { return true; } });
  const setSound = (v: boolean | ((x: boolean) => boolean)) => setSoundState((cur) => {
    const next = typeof v === 'function' ? v(cur) : v;
    try { localStorage.setItem(SOUND_KEY, next ? '1' : '0'); } catch { /* storage blocked */ }
    return next;
  });
  const [blocked, setBlocked] = useState(false);
  const [mic, setMic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const micStop = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!sound) return;
    if (!MediaSourceImpl) { setError('Dieser Browser kann den Ton nicht abspielen.'); setSoundState(false); return; }
    const el = new Audio();
    (el as HTMLAudioElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
    audio.current = el;
    let alive = true;
    // what this browser plays: Opus/WebM (Chrome, Edge, Firefox) or AAC/MP4 (Safari, iPhone – converted on the server)
    const codec = MediaSourceImpl.isTypeSupported(WEBM) ? 'webm' : 'mp4';
    const play = () => el.play().then(() => setBlocked(false), (err) => { if (err?.name === 'NotAllowedError') setBlocked(true); });
    const unlock = () => { if (el.src) play(); };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    let ms: MediaSource | null = null;
    let sb: SourceBuffer | null = null;
    let queue: Uint8Array[] = [];
    const pump = () => {
      if (!sb || sb.updating || !queue.length || ms?.readyState !== 'open') return;
      try { sb.appendBuffer(queue.shift()! as BufferSource); } catch { queue = []; }
    };
    const live = () => {
      if (!sb || !el.buffered.length) return;
      const end = el.buffered.end(el.buffered.length - 1);
      if (end - el.currentTime > 0.6) el.currentTime = Math.max(0, end - 0.15); // stay at the live edge
      if (!sb.updating && el.currentTime > 30) { try { sb.remove(0, el.currentTime - 10); } catch { /* busy */ } }
      if (el.paused) play();
    };
    // every recording start (new tab, new listener) brings a new header: start a fresh pipeline with it
    const begin = (codec: string, init: Uint8Array) => {
      const mime = codec === 'webm' ? WEBM : MIME;
      if (!MediaSourceImpl!.isTypeSupported(mime)) { setError(codec === 'webm' ? 'Dieser Browser spielt den Ton (Opus/WebM) nicht ab – Chrome, Edge oder Firefox verwenden.' : 'Dieser Browser kann den Ton nicht abspielen.'); return; }
      if (el.src) URL.revokeObjectURL(el.src);
      const next = new MediaSourceImpl!();
      ms = next; sb = null; queue = [init];
      el.src = URL.createObjectURL(next);
      next.addEventListener('sourceopen', () => {
        if (ms !== next) return;
        sb = next.addSourceBuffer(mime);
        sb.mode = 'sequence';
        sb.addEventListener('updateend', () => { pump(); live(); });
        pump();
      });
      play();
    };
    const off = conn.onMessage((m) => {
      if (m.t !== 'bmedia' || m.profileId !== profileId || m.kind !== 'audio') return;
      if (m.reset || m.ended) { queue = []; return; }
      if (m.init) begin(m.codec ?? 'mp4', b64(m.init));
      else if (m.data && (sb || queue.length)) { queue.push(b64(m.data)); if (queue.length > 40) queue.splice(1, queue.length - 20); pump(); }
    });
    // not running yet / just starting: ask again until the browser is there (the server waits for the extension)
    let retry = 0;
    const ask = () => conn.call('browsers.audio', { id: profileId, on: true, codec }).catch((e) => {
      if (!alive) return;
      if (/läuft nicht/.test(e.message) && retry++ < 30) { setTimeout(ask, 2000); return; }
      setError(e.message);
    });
    ask();
    return () => {
      alive = false;
      off();
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      setBlocked(false);
      conn.send('browsers.audio', { id: profileId, on: false });
      el.pause();
      if (el.src) URL.revokeObjectURL(el.src);
      audio.current = null;
    };
  }, [sound, profileId]);

  useEffect(() => {
    if (!mic) return;
    let stopped = false;
    (async () => {
      try {
        await conn.call('browsers.mic', { id: profileId, on: true });
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const code = `class P extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('cockpit-mic',P)`;
        const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(ctx, 'cockpit-mic');
        const ratio = ctx.sampleRate / MIC_RATE;
        const id = new TextEncoder().encode(profileId);
        let carry = 0;
        let pending: number[] = [];
        node.port.onmessage = (e: MessageEvent<Float32Array>) => {
          const x = e.data;
          // resample (linear) to 24 kHz, 16 bit
          let t = carry;
          for (; t < x.length - 1; t += ratio) {
            const i = Math.floor(t), f = t - i;
            const v = x[i] * (1 - f) + x[i + 1] * f;
            pending.push(Math.max(-1, Math.min(1, v)) * 0x7fff);
          }
          carry = Math.max(0, t - x.length);
          if (pending.length < MIC_RATE / 50) return; // ~20 ms per frame
          const pcm = new Int16Array(pending);
          pending = [];
          const frame = new Uint8Array(2 + id.length + pcm.byteLength);
          frame[0] = 1; frame[1] = id.length;
          frame.set(id, 2);
          frame.set(new Uint8Array(pcm.buffer), 2 + id.length);
          conn.sendBinary(frame);
        };
        src.connect(node);
        micStop.current = () => { stream.getTracks().forEach((t) => t.stop()); ctx.close().catch(() => {}); };
        if (stopped) micStop.current();
      } catch (e) {
        setError((e as Error).name === 'NotAllowedError' ? 'Mikrofon wurde nicht erlaubt.' : (e as Error).message);
        setMic(false);
      }
    })();
    return () => {
      stopped = true;
      micStop.current?.();
      micStop.current = null;
      conn.send('browsers.mic', { id: profileId, on: false });
    };
  }, [mic, profileId]);

  // camera: 640×480 JPEG frames, ~15 per second, as binary frames [2][id]
  const [cam, setCam] = useState(false);
  const preview = useRef<MediaStream | null>(null);
  useEffect(() => {
    if (!cam) return;
    let stop = () => {};
    let done = false;
    (async () => {
      try {
        await conn.call('browsers.cam', { id: profileId, on: true });
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } } });
        preview.current = stream;
        const v = document.createElement('video');
        v.muted = true; v.playsInline = true; v.srcObject = stream;
        await v.play();
        const c = document.createElement('canvas');
        const g = c.getContext('2d')!;
        const id = new TextEncoder().encode(profileId);
        let busy = false;
        const timer = window.setInterval(() => {
          if (busy || !v.videoWidth) return;
          const w = Math.min(640, v.videoWidth), h = Math.round((w / v.videoWidth) * v.videoHeight);
          if (c.width !== w) { c.width = w; c.height = h; }
          g.drawImage(v, 0, 0, w, h);
          busy = true;
          c.toBlob((b) => {
            busy = false;
            if (!b) return;
            b.arrayBuffer().then((buf) => {
              const f = new Uint8Array(2 + id.length + buf.byteLength);
              f[0] = 2; f[1] = id.length; f.set(id, 2); f.set(new Uint8Array(buf), 2 + id.length);
              conn.sendBinary(f);
            });
          }, 'image/jpeg', 0.7);
        }, 66);
        stop = () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); preview.current = null; };
        if (done) stop();
      } catch (e) {
        setError((e as Error).name === 'NotAllowedError' ? 'Kamera wurde nicht erlaubt.' : (e as Error).message);
        setCam(false);
      }
    })();
    return () => { done = true; stop(); conn.send('browsers.cam', { id: profileId, on: false }); };
  }, [cam, profileId]);

  return { sound, setSound, blocked, mic, setMic, cam, setCam, error, clearError: () => setError(null) };
}
