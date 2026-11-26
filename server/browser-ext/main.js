// agentpit media bridge – page world. Only replaces what a remote viewer needs: getUserMedia and
// enumerateDevices answer with the viewer's microphone/camera while the viewer has switched them on;
// otherwise everything goes to the browser's own implementation unchanged. The stream itself is
// built in the extension's isolated world (isolated.js) and handed over through the DOM.
(() => {
  const K = 'apx9f3c';
  const md = navigator.mediaDevices;
  if (!md || !window.MediaDevices) return;
  const proto = MediaDevices.prototype;
  const origGum = proto.getUserMedia;
  const origEnum = proto.enumerateDevices;
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const parse = JSON.parse;
  let state = null;
  let ready;
  const stateReady = new Promise((r) => { ready = r; });
  add.call(document, `${K}s`, (e) => { try { state = parse(e.detail); ready(); } catch { /* ignore */ } }, true);
  setTimeout(() => ready(), 800); // no extension answer → behave like a normal browser

  const request = (kind) => new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const type = `${K}r${id}`;
    const timer = setTimeout(() => { remove.call(document, type, on, true); reject(new DOMException('Could not start source', 'NotReadableError')); }, 6000);
    function on(e) {
      clearTimeout(timer);
      remove.call(document, type, on, true);
      const s = e.relatedTarget && e.relatedTarget.srcObject;
      if (s) resolve(s); else reject(new DOMException('Could not start source', 'NotReadableError'));
    }
    add.call(document, type, on, true);
    dispatch.call(document, new CustomEvent(`${K}q`, { detail: `${id}:${kind}` }));
  });

  const fakes = new Map();
  const getUserMedia = { async getUserMedia(constraints) {
    await stateReady;
    const c = constraints || {};
    const mic = !!c.audio && !!state && state.mic;
    const cam = !!c.video && !!state && state.cam;
    if (!mic && !cam) return origGum.call(this, constraints);
    const tracks = [];
    try {
      if (mic) for (const t of (await request('mic')).getAudioTracks()) tracks.push(t);
      if (cam) for (const t of (await request('cam')).getVideoTracks()) tracks.push(t);
      const rest = { audio: mic ? false : c.audio, video: cam ? false : c.video };
      if (rest.audio || rest.video) for (const t of (await origGum.call(this, rest)).getTracks()) tracks.push(t);
    } catch (err) {
      for (const t of tracks) t.stop();
      throw err;
    }
    return new MediaStream(tracks);
  } }.getUserMedia;

  const enumerateDevices = { async enumerateDevices() {
    const list = await origEnum.call(this);
    await stateReady;
    if (!state || (!state.mic && !state.cam)) return list;
    const own = [];
    const fake = (kind, label) => {
      const o = Object.create((kind === 'audioinput' || kind === 'videoinput') && window.InputDeviceInfo ? InputDeviceInfo.prototype : MediaDeviceInfo.prototype);
      const v = { deviceId: `${kind}-remote`, groupId: 'remote', kind, label };
      for (const k of Object.keys(v)) Object.defineProperty(o, k, { get: () => v[k], enumerable: true });
      Object.defineProperty(o, 'toJSON', { value: () => ({ ...v }) });
      return o;
    };
    if (state.mic) own.push(fake('audioinput', 'Mikrofon'));
    if (state.cam) own.push(fake('videoinput', 'Kamera'));
    return [...own, ...list.filter((d) => !(state.mic && d.kind === 'audioinput') && !(state.cam && d.kind === 'videoinput'))];
  } }.enumerateDevices;

  // look like the built-ins: plain Function prototype, same length, native source text
  for (const f of [getUserMedia, enumerateDevices]) { Object.setPrototypeOf(f, Function.prototype); Object.defineProperty(f, 'length', { value: 0 }); }
  fakes.set(getUserMedia, 'function getUserMedia() { [native code] }');
  fakes.set(enumerateDevices, 'function enumerateDevices() { [native code] }');
  const nativeToString = Function.prototype.toString;
  const toString = { toString() { return fakes.has(this) ? fakes.get(this) : nativeToString.call(this); } }.toString;
  fakes.set(toString, nativeToString.call(nativeToString));
  Object.defineProperty(Function.prototype, 'toString', { value: toString, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(proto, 'getUserMedia', { value: getUserMedia, writable: true, configurable: true, enumerable: true });
  Object.defineProperty(proto, 'enumerateDevices', { value: enumerateDevices, writable: true, configurable: true, enumerable: true });
})();
