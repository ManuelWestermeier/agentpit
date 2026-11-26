// agentpit media bridge – isolated world of every frame (invisible to the page's scripts).
// Builds the viewer's microphone (PCM from the cockpit) and camera (JPEG frames) as MediaStreams
// and hands them to main.js; turns <select> dropdowns into a list on the viewer's screen (the native
// dropdown is a separate OS widget that never shows up in the remote picture).
(() => {
  const K = 'apx9f3c';
  let st = { mic: false, cam: false, remote: false };
  const tell = () => document.dispatchEvent(new CustomEvent(`${K}s`, { detail: JSON.stringify({ mic: st.mic, cam: st.cam }) }));
  const send = (m) => { try { chrome.runtime.sendMessage(m).catch(() => {}); } catch { /* extension reloaded */ } };

  chrome.runtime.sendMessage({ t: 'state?' }).then((s) => { if (s) st = s; tell(); }).catch(() => tell());

  // ---- microphone: 24 kHz mono PCM s16 → ring buffer → ScriptProcessor → MediaStream
  const RATE = 24000;
  let mic = null;
  function micStream() {
    if (mic) return mic.dest.stream;
    const ctx = new AudioContext({ sampleRate: RATE });
    const ring = new Float32Array(RATE * 2);
    let w = 0, r = 0, filled = 0;
    const node = ctx.createScriptProcessor(1024, 1, 1);
    node.onaudioprocess = (e) => {
      const out = e.outputBuffer.getChannelData(0);
      if (filled > RATE * 0.4) { r = (w - RATE * 0.08 + ring.length) % ring.length; filled = RATE * 0.08; } // too far behind → catch up
      for (let i = 0; i < out.length; i++) {
        if (filled > 0) { out[i] = ring[r]; r = (r + 1) % ring.length; filled--; } else out[i] = 0;
      }
    };
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    ctx.resume().catch(() => {});
    mic = { ctx, dest, write(pcm) {
      for (let i = 0; i < pcm.length; i++) { ring[w] = pcm[i] / 0x8000; w = (w + 1) % ring.length; }
      filled = Math.min(ring.length, filled + pcm.length);
    } };
    send({ t: 'consumer', kind: 'mic' });
    return dest.stream;
  }

  // ---- camera: JPEG frames → canvas → captureStream
  let cam = null;
  function camStream() {
    if (cam) return cam.stream;
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 480;
    const g = canvas.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 640, 480);
    cam = { canvas, g, stream: canvas.captureStream(30) };
    send({ t: 'consumer', kind: 'cam' });
    return cam.stream;
  }
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  document.addEventListener(`${K}q`, (e) => {
    const [id, kind] = String(e.detail).split(':');
    let stream = null;
    try { stream = kind === 'mic' ? micStream() : kind === 'cam' ? camStream() : null; } catch { /* no audio in this frame */ }
    const el = document.createElement(kind === 'cam' ? 'video' : 'audio');
    if (stream) el.srcObject = stream;
    document.dispatchEvent(new MouseEvent(`${K}r${id}`, { relatedTarget: stream ? el : null }));
  }, true);

  // ---- <select> while someone watches remotely
  const selects = new Map();
  let seq = 0;
  document.addEventListener('mousedown', (e) => {
    if (!st.remote || e.button !== 0) return;
    const t = e.composedPath()[0];
    const s = t && t.closest ? t.closest('select') : null;
    if (!s || s.multiple || s.size > 1 || s.disabled) return;
    e.preventDefault();
    s.focus();
    const id = `${++seq}`;
    selects.set(id, s);
    const opts = [...s.options].map((o) => ({ label: o.label || o.text, disabled: o.disabled, group: o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '' }));
    send({ t: 'select', id, title: s.getAttribute('aria-label') || (s.labels && s.labels[0] ? s.labels[0].textContent.trim() : '') || s.name || '', index: s.selectedIndex, options: opts.slice(0, 1000) });
  }, true);

  chrome.runtime.onMessage.addListener((m) => {
    if (m.t === 'state') { st = m.st; tell(); }
    else if (m.t === 'pcm' && mic) mic.write(new Int16Array(b64(m.b).buffer));
    else if (m.t === 'cam' && cam) {
      createImageBitmap(new Blob([b64(m.b)], { type: 'image/jpeg' })).then((img) => {
        if (cam.canvas.width !== img.width) { cam.canvas.width = img.width; cam.canvas.height = img.height; }
        cam.g.drawImage(img, 0, 0);
        img.close();
      }).catch(() => {});
    } else if (m.t === 'choose') {
      const s = selects.get(m.id);
      selects.clear();
      if (!s || m.index == null || m.index < 0 || m.index >= s.options.length || s.selectedIndex === m.index) return;
      // the native value setter, so frameworks (React) see the change
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').set.call(s, m.index);
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
})();
