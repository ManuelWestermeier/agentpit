// Identity end-to-end: the real Playwright MCP (what Claude uses) through the cockpit's CDP relay.
// Switching identities mid-session, auto-start, adopting a browser after a cockpit restart, and
// that one identity can never end up in another identity's browser. No Claude session needed.
//   npm run test:browser      (Linux without a screen: xvfb-run -a npm run test:browser)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Browsers } from '../server/browsers.js';
import { CdpRelay } from '../server/cdp-relay.js';
import { findBrowserExecutable, playwrightMcpCli } from '../server/environment.js';
import { Store } from '../server/store.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, 'browsers');
const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const engine = process.env.E2E_ENGINE || ['chrome', 'msedge', 'chromium'].find((e) => findBrowserExecutable(e));
const skip = !engine || !findBrowserExecutable(engine) || !playwrightMcpCli(ROOT) ? 'kein Browser oder @playwright/mcp' : false;

function makeBrowsers(dir) {
  const store = new Store(dir);
  const ctx = { store, root: ROOT, config: { maxBrowsers: 4, trashDir: path.join(dir, 'trash') }, env: { browser: {} }, projects: { list: async () => [] }, hub: { send() {}, toAll() {} } };
  return { b: new Browsers(ctx), store };
}

/** text of a Playwright MCP tool result */
async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.map((c) => c.text ?? '').join('\n') ?? '';
  return { ok: !r.isError, text };
}
const langOf = async (client) => {
  const r = await call(client, 'browser_evaluate', { function: '() => navigator.language' });
  assert.ok(r.ok, r.text);
  const lang = /"(de-DE|en-US)"/.exec(r.text)?.[1];
  assert.ok(lang, `keine Sprache in der Antwort: ${r.text.slice(0, 400)}`);
  return lang;
};

describe(`Identitäten über CDP-Relay (${engine})`, { skip, concurrency: false }, () => {
  let dir, b, store, relay, client, token, active;
  const ids = {};

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-ident-'));
    ({ b, store } = makeBrowsers(dir));
    await store.init();
    await b.init();
    // two identities that differ visibly: language
    ids.de = (await b.create({ name: 'Konto DE', engine, headless: true, lang: 'de-DE' })).id;
    ids.en = (await b.create({ name: 'Konto EN', engine, headless: true, lang: 'en-US' })).id;
    relay = new CdpRelay();
    await relay.start();
    active = ids.de;
    token = relay.add(() => b.ensureRunning(active)); // like Runner#resolveBrowser
    client = new Client({ name: 'e2e', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [playwrightMcpCli(ROOT), '--cdp-endpoint', relay.endpoint(token), '--output-dir', path.join(dir, 'mcp-out')], stderr: 'ignore' }));
  });

  after(async () => {
    await client?.close().catch(() => {});
    await relay?.stop();
    await b?.stopAll();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file locks */ }
  });

  test('erster Aufruf startet die Identität automatisch', { timeout: 60_000 }, async () => {
    assert.equal(b.running.has(ids.de), false);
    assert.equal(await langOf(client), 'de-DE');
    assert.equal(b.running.has(ids.de), true);
  });

  test('Wechsel mitten in der Session: nächster Aufruf läuft in der anderen Identität', { timeout: 60_000 }, async () => {
    await call(client, 'browser_navigate', { url: 'data:text/html,<title>Tab-DE</title>' });
    active = ids.en;
    await relay.retarget(token);
    assert.equal(await langOf(client), 'en-US');
    active = ids.de;
    await relay.retarget(token);
    assert.equal(await langOf(client), 'de-DE');
    const tabs = await call(client, 'browser_tabs', { action: 'list' });
    assert.match(tabs.text, /Tab-DE/, 'Tabs der Identität bleiben erhalten');
  });

  test('gestoppte Identität wird beim nächsten Aufruf wieder gestartet', { timeout: 60_000 }, async () => {
    await b.stop(ids.de);
    assert.equal(b.running.has(ids.de), false);
    assert.equal(await langOf(client), 'de-DE');
    assert.equal(b.running.has(ids.de), true);
  });

  test('Cockpit-Neustart: laufender Browser wird übernommen statt doppelt gestartet', { timeout: 60_000 }, async () => {
    const page = b.running.get(ids.de).active;
    await page.goto('data:text/html,<title>bleibt-offen</title>');
    const port = b.running.get(ids.de).port;
    // a second cockpit process on the same data, while the first one's browser keeps running
    const second = makeBrowsers(dir);
    await second.b.init();
    await second.b.start(ids.de);
    const e = second.b.running.get(ids.de);
    assert.equal(e.proc, null, 'kein neuer Browser-Prozess');
    assert.equal(e.port, port);
    const titles = await Promise.all(e.context.pages().map((p) => p.title()));
    assert.ok(titles.includes('bleibt-offen'), `offene Seite erhalten: ${titles}`);
    await e.browser.close().catch(() => {}); // disconnect only (connectOverCDP)
  });

  test('eine Identität übernimmt nie den Browser einer anderen', { timeout: 60_000 }, async () => {
    // corrupt the saved port of EN so that it points at DE's running browser
    await b.ensureRunning(ids.de);
    const dePort = b.running.get(ids.de).port;
    await b.stop(ids.en);
    const other = makeBrowsers(dir);
    await other.b.init();
    other.b.profiles.get(ids.en).port = dePort;
    await other.b.start(ids.en);
    const e = other.b.running.get(ids.en);
    assert.notEqual(e.port, dePort, 'eigener Port statt fremdem Browser');
    assert.ok(e.proc, 'eigener Browser-Prozess');
    const lang = await e.active.evaluate(() => navigator.language);
    assert.equal(lang, 'en-US');
    await other.b.stop(ids.en);
  });
});
