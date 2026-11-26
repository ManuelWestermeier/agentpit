// agentpit media bridge – offscreen document: records the shown tab's sound (tab capture, so it no
// longer plays on the server's speakers) as Opus/WebM in 100 ms pieces and sends them to the cockpit.
let ws = null;
let rec = null;
let stream = null;
let audioEl = null;

async function connect() {
  const c = await fetch(chrome.runtime.getURL('config.json'), { cache: 'no-store' }).then((r) => r.json());
  ws = new WebSocket(`ws://127.0.0.1:${c.port}/ext?role=off&id=${encodeURIComponent(c.id)}&token=${encodeURIComponent(c.token)}`);
  ws.binaryType = 'arraybuffer';
  ws.onclose = () => { ws = null; setTimeout(connect, 2000); };
  ws.onerror = () => {};
}

function stop() {
  try { rec?.state !== 'inactive' && rec?.stop(); } catch { /* stopped */ }
  stream?.getTracks().forEach((t) => t.stop());
  if (audioEl) { audioEl.srcObject = null; audioEl = null; }
  rec = null; stream = null;
}

async function start({ streamId, local }) {
  stop();
  stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } });
  if (local) { audioEl = new Audio(); audioEl.srcObject = stream; audioEl.play().catch(() => {}); } // also keep playing on this machine
  const mimeType = 'audio/webm;codecs=opus';
  rec = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 96_000 });
  ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'begin', codec: 'webm' }));
  rec.ondataavailable = async (e) => {
    if (!e.data.size || ws?.readyState !== 1) return;
    ws.send(await e.data.arrayBuffer());
  };
  rec.start(100);
}

chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m.to !== 'off') return false;
  if (m.t === 'start') start(m).then(() => reply(true), () => reply(false)); // the worker retries and reports
  else if (m.t === 'stop') { stop(); reply(true); }
  return true;
});
connect();
