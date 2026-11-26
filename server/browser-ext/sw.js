// agentpit media bridge – service worker. One WebSocket to the cockpit (127.0.0.1, token from
// config.json written by the cockpit for this identity): control messages, microphone and camera
// data in, dropdown requests out. Tab sound is recorded in the offscreen document (offscreen.js).
let cfg = null;
let ws = null;
let st = { mic: false, cam: false, remote: false };
let capturing = false;
let consumers = new Map(); // tabId → Set(kind)

// read again on every connect: a restarted cockpit (other port) rewrites it for browsers that kept running
async function config() {
  cfg = await fetch(chrome.runtime.getURL('config.json'), { cache: 'no-store' }).then((r) => r.json()).catch(() => cfg);
  return cfg;
}

async function connect() {
  const c = await config();
  if (!c || (ws && ws.readyState <= 1)) return;
  ws = new WebSocket(`ws://127.0.0.1:${c.port}/ext?role=sw&id=${encodeURIComponent(c.id)}&token=${encodeURIComponent(c.token)}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => (typeof e.data === 'string' ? control(JSON.parse(e.data)) : media(new Uint8Array(e.data)));
  ws.onclose = () => { ws = null; setTimeout(connect, 2000); };
  ws.onerror = () => {};
}

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const activeTab = async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] ?? (await chrome.tabs.query({ active: true }))[0];

async function broadcastState() {
  for (const t of await chrome.tabs.query({})) chrome.tabs.sendMessage(t.id, { t: 'state', st }).catch(() => {});
}

async function control(m) {
  if (m.t === 'state') { st = { ...st, ...m.st }; broadcastState(); }
  else if (m.t === 'capture') {
    if (m.on) await startCapture(m);
    else await stopCapture();
  } else if (m.t === 'choose') chrome.tabs.sendMessage(m.tab, { t: 'choose', id: m.id, index: m.index }, { frameId: m.frame }).catch(() => {});
}

/** Microphone (1) and camera (2) data go to every frame of the tab that asked for them. */
async function media(u8) {
  const kind = u8[0] === 1 ? 'mic' : u8[0] === 2 ? 'cam' : null;
  if (!kind) return;
  const msg = { t: kind === 'mic' ? 'pcm' : 'cam', b: b64(u8.subarray(1)) };
  for (const [tab, kinds] of consumers) if (kinds.has(kind)) chrome.tabs.sendMessage(tab, msg).catch(() => consumers.delete(tab));
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Tab-Ton an den Fernzugriff übertragen' }).catch(() => {});
}

async function startCapture({ local }) {
  const tab = await activeTab();
  if (!tab) return;
  await ensureOffscreen();
  await stopCapture();
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    capturing = true;
    await chrome.runtime.sendMessage({ to: 'off', t: 'start', streamId, local: !!local });
  } catch (e) {
    ws?.send(JSON.stringify({ t: 'error', text: `Ton: ${e.message}` }));
  }
}

async function stopCapture() {
  if (!capturing) return;
  capturing = false;
  await chrome.runtime.sendMessage({ to: 'off', t: 'stop' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.to === 'off') return false;
  if (m.t === 'state?') { reply(st); return false; }
  const tab = sender.tab?.id;
  if (m.t === 'consumer' && tab != null) { if (!consumers.has(tab)) consumers.set(tab, new Set()); consumers.get(tab).add(m.kind); }
  else if (m.t === 'select' && tab != null) ws?.send(JSON.stringify({ ...m, tab, frame: sender.frameId ?? 0 }));
  return false;
});
chrome.tabs.onRemoved.addListener((id) => consumers.delete(id));

// keep the worker (and its WebSocket) alive: messages reset the idle timer, the alarm restarts it
setInterval(() => { if (ws?.readyState === 1) ws.send('{"t":"ping"}'); }, 20_000);
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
