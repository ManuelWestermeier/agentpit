import { useEffect, useRef, useState } from 'react';
import { conn } from './ws';

const MIC_RATE = 24_000; // server/audio.js MIC_RATE
const MIME = 'audio/mp4; codecs="mp4a.40.2"';

type MS = typeof MediaSource;
const MediaSourceImpl: MS | undefined = (window as unknown as { ManagedMediaSource?: MS }).ManagedMediaSource ?? window.MediaSource;
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Sound of the remote browser (fMP4/AAC fragments over the WebSocket → MediaSource) and the
 * viewer's microphone into it (PCM 24 kHz mono, binary frames). Latency is kept short: when the
 * buffer runs ahead, playback jumps to the live edge instead of drifting behind the picture.
 */
export function useRemoteAudio(profileId: string) {
  const [sound, setSound] = useState(false);
  const [mic, setMic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const micStop = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!sound) return;
    if (!MediaSourceImpl?.isTypeSupported(MIME)) { setError('Dieser Browser kann den Ton nicht abspielen.'); setSound(false); return; }
    const ms = new MediaSourceImpl();
    const el = new Audio();
    (el as HTMLAudioElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
    el.src = URL.createObjectURL(ms);
    audio.current = el;
    let sb: SourceBuffer | null = null;
    const queue: Uint8Array[] = [];
    let alive = true;
    const pump = () => {
      if (!sb || sb.updating || !queue.length) return;
      try { sb.appendBuffer(queue.shift()! as BufferSource); } catch { queue.length = 0; }
    };
    const live = () => {
      if (!sb || !el.buffered.length) return;
      const end = el.buffered.end(el.buffered.length - 1);
      if (end - el.currentTime > 0.6) el.currentTime = Math.max(0, end - 0.15);
      if (!sb.updating && el.currentTime > 30) { try { sb.remove(0, el.currentTime - 10); } catch { /* busy */ } }
      if (el.paused) el.play().catch(() => {});
    };
    ms.addEventListener('sourceopen', () => {
      sb = ms.addSourceBuffer(MIME);
      sb.mode = 'sequence';
      sb.addEventListener('updateend', () => { pump(); live(); });
      pump();
    });
    const off = conn.onMessage((m) => {
      if (m.t !== 'bmedia' || m.profileId !== profileId || m.kind !== 'audio') return;
      if (m.ended) return;
      if (m.init) queue.unshift(b64(m.init));
      else if (m.data) { queue.push(b64(m.data)); if (queue.length > 40) queue.splice(1, queue.length - 20); }
      pump();
    });
    el.play().catch(() => {});
    conn.call('browsers.audio', { id: profileId, on: true }).catch((e) => { if (alive) { setError(e.message); setSound(false); } });
    return () => {
      alive = false;
      off();
      conn.send('browsers.audio', { id: profileId, on: false });
      el.pause();
      URL.revokeObjectURL(el.src);
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

  return { sound, setSound, mic, setMic, error, clearError: () => setError(null) };
}
