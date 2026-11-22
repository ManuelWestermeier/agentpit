import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const fail = (e) => ({ content: [{ type: 'text', text: `Fehler: ${e.message}` }], isError: true });
const wrap = (fn) => async (args) => { try { return text(await fn(args)); } catch (e) { return fail(e); } };

function table(r) {
  const head = r.columns.join(' | ');
  const rows = r.rows.map((row) => row.map((v) => (v == null ? 'NULL' : String(v).replace(/\n/g, ' ').slice(0, 300))).join(' | '));
  return `${head}\n${rows.join('\n')}\n(${r.rowCount} Zeilen${r.truncated ? ', gekürzt auf 500' : ''}, ${r.ms} ms)`;
}

/**
 * Approved without asking: read-only tools, and switching between the user's own identities
 * (reversible, visible live in the cockpit). Starting sessions, sending prompts and schedules ask.
 */
export const COCKPIT_SAFE_TOOLS = new Set([
  'db_connections', 'db_schema', 'db_query', 'services_list', 'service_logs', 'browser_info', 'browser_use',
  'session_list', 'session_status', 'session_wait', 'schedule_list',
].map((n) => `mcp__cockpit__${n}`));

const MAX_DEPTH = 3;            // session → sub → sub-sub
const MAX_SPAWNS_PER_HOUR = 12; // per parent session
const spawnLog = new Map();     // projectId → timestamps

function short(r) {
  if (!r) return null;
  return { text: r.text.length > 4000 ? `${r.text.slice(0, 4000)} … (gekürzt)` : r.text, fehler: r.isError, zeit: new Date(r.at).toISOString(), kostenUsd: Math.round(r.costUsd * 1000) / 1000 };
}

/** In-process MCP server bound to one project: databases, services, browser identities, sub-sessions, schedules. */
export function cockpitMcp(ctx, projectId) {
  const { databases, services, browsers, projects } = ctx;

  const identity = (id) => {
    const b = browsers.list({ hidden: true }).find((x) => x.id === id);
    return b && { id: b.id, name: b.hidden ? 'isoliert (nur dieses Projekt, keine Logins geteilt)' : b.name, läuft: b.running, url: b.url, titel: b.title };
  };
  const target = async (session) => {
    const id = String(session ?? '').trim();
    if (!id) throw new Error('session fehlt (Projekt-ID aus session_list)');
    if (id === projectId) throw new Error('Das ist diese Session selbst');
    return projects.get(id);
  };
  const depth = async (id) => {
    let d = 0;
    for (let p = await projects.get(id).catch(() => null); p?.parentId && d < 10; p = await projects.get(p.parentId).catch(() => null)) d++;
    return d;
  };
  return createSdkMcpServer({
    name: 'cockpit',
    version: '1.0.0',
    tools: [
      tool('db_connections', 'Listet die im Cockpit für dieses Projekt eingerichteten Datenbankverbindungen (ohne Passwörter).', {},
        wrap(async () => (await databases.list(projectId)).map(({ id, name, type, writable, note }) => ({ id, name, type, writable, note })))),
      tool('db_schema', 'Tabellen und Spalten einer Datenbankverbindung.', { connection: z.string().describe('id aus db_connections') },
        wrap(async ({ connection }) => databases.schema(projectId, connection))),
      tool('db_query', 'Liest Daten per SQL (läuft in einer Read-only-Transaktion, max. 500 Zeilen).', { connection: z.string(), sql: z.string() },
        wrap(async ({ connection, sql }) => table(await databases.run(projectId, connection, sql, 'read')))),
      tool('db_execute', 'Ändert Daten oder Schema per SQL. Nur bei Verbindungen mit Schreibfreigabe; der Nutzer bestätigt jeden Aufruf.', { connection: z.string(), sql: z.string() },
        wrap(async ({ connection, sql }) => table(await databases.run(projectId, connection, sql, 'write')))),
      tool('services_list', 'Dienste (Dev-Server usw.) dieses Projekts mit Status und URL.', {},
        wrap(async () => (await services.list(projectId)).map(({ id, name, command, status, detectedUrl, url, exitCode }) => ({ id, name, command, status, url: url || detectedUrl, exitCode })))),
      tool('service_logs', 'Letzte Log-Zeilen eines Dienstes.', { id: z.string(), lines: z.number().int().min(1).max(2000).optional() },
        wrap(async ({ id, lines }) => services.logs(projectId, id, lines ?? 200) || '(keine Ausgabe)')),
      tool('service_define', 'Legt einen Dienst an oder ändert ihn (wird in cockpit.services.json gespeichert und im Cockpit angezeigt).',
        { name: z.string(), command: z.string(), cwd: z.string().optional(), url: z.string().optional(), autostart: z.boolean().optional(), id: z.string().optional() },
        wrap(async (a) => services.save(projectId, a))),
      tool('service_start', 'Startet einen Dienst.', { id: z.string() }, wrap(async ({ id }) => { await services.start(projectId, id); return `gestartet: ${id}`; })),
      tool('service_stop', 'Stoppt einen Dienst.', { id: z.string() }, wrap(async ({ id }) => { await services.stop(projectId, id); return `gestoppt: ${id}`; })),
      // ---- browser identities
      tool('browser_info', 'Welche Browser-Identität Playwright gerade steuert, und alle verfügbaren Identitäten (eigene Profile mit eigenen Logins).', {},
        wrap(async () => {
          const runner = await ctx.runners.get(projectId);
          const active = await runner.activeBrowserId();
          const all = await projects.list();
          return {
            aktiv: identity(active),
            identitäten: browsers.list().map((b) => ({ ...identity(b.id), genutztVon: all.filter((p) => p.browserProfile === b.id).map((p) => p.id) })),
            hinweis: 'browser_use wechselt sofort. Der Nutzer sieht jede Identität live und loggt sich dort selbst ein; Logins bleiben im Profil gespeichert, auch nach Neustarts.',
          };
        })),
      tool('browser_use', 'Wechselt die Browser-Identität dieser Session sofort (der nächste Playwright-Aufruf läuft im anderen Profil, mit dessen Logins). identity = id aus browser_info, leer = isolierter Browser ohne Logins.',
        { identity: z.string().describe('id der Identität oder "" für isoliert') },
        wrap(async ({ identity: id }) => {
          id = String(id ?? '').trim();
          if (id && !browsers.list().some((b) => b.id === id)) throw new Error(`Identität „${id}“ gibt es nicht – siehe browser_info`);
          await projects.update(projectId, { browserProfile: id });
          const runner = await ctx.runners.get(projectId);
          runner.project = await projects.get(projectId);
          await runner.browserChanged(); // old connection is gone before Claude's next Playwright call
          return { aktiv: identity(await runner.activeBrowserId()), hinweis: 'Gewechselt. Offene Tabs der vorherigen Identität bleiben dort erhalten.' };
        })),
      tool('browser_create', 'Legt eine neue Browser-Identität an (eigenes Profil, z. B. pro Account). Einloggen muss sich der Nutzer selbst.',
        { name: z.string(), engine: z.enum(['chrome', 'msedge', 'chromium']).optional() },
        wrap(async ({ name, engine }) => {
          const p = await browsers.create({ name, ...(engine ? { engine } : {}) });
          return { id: p.id, name: p.name, hinweis: `Mit browser_use("${p.id}") nutzen. Der Nutzer muss sich in dieser Identität einmal selbst einloggen.` };
        })),

      // ---- sub-sessions
      tool('session_list', 'Alle Claude-Sessions (Projekte) im Cockpit mit Status, Identität und letztem Ergebnis.', {},
        wrap(async () => (await projects.list()).map((p) => {
          const r = ctx.runners.peek(p.id);
          return { id: p.id, name: p.name, vonSession: p.parentId || null, status: r?.state ?? 'idle', identität: p.browserProfile || 'isoliert', diese: p.id === projectId, letztesErgebnis: r?.lastResult ? r.lastResult.text.slice(0, 300) : null };
        }))),
      tool('session_create', 'Startet eine neue Claude-Session (eigenes Projekt mit eigenem Ordner) und gibt ihr optional sofort eine Aufgabe. Erbt Modell und Berechtigungsmodus; optional eigene Browser-Identität. Für parallele Arbeit, z. B. eine Session pro Account.',
        { name: z.string().describe('kurzer Name, wird zur Projekt-ID'), task: z.string().optional().describe('erster Prompt / Aufgabe'), identity: z.string().optional().describe('Browser-Identität (id aus browser_info)'), model: z.string().optional() },
        wrap(async ({ name, task, identity: id, model }) => {
          if (await depth(projectId) >= MAX_DEPTH) throw new Error(`Maximal ${MAX_DEPTH} Ebenen Sub-Sessions`);
          const now = Date.now();
          const recent = (spawnLog.get(projectId) ?? []).filter((t) => now - t < 3600_000);
          if (recent.length >= MAX_SPAWNS_PER_HOUR) throw new Error(`Maximal ${MAX_SPAWNS_PER_HOUR} neue Sessions pro Stunde`);
          if (id && !browsers.list().some((b) => b.id === id)) throw new Error(`Identität „${id}“ gibt es nicht`);
          const parent = await projects.get(projectId);
          const child = await projects.create({ name, parentId: projectId, mode: parent.mode, effort: parent.effort, model: model ?? parent.model, browserProfile: id ?? '' });
          spawnLog.set(projectId, [...recent, now]);
          let started = false;
          if (task?.trim()) {
            await (await ctx.runners.get(child.id)).send(`[Aufgabe von Session „${projectId}“]\n${task}`, { source: projectId });
            started = true;
          }
          return { id: child.id, gestartet: started, hinweis: 'Mit session_wait auf das Ergebnis warten oder session_status abfragen. Freigaben der Sub-Session erteilt der Nutzer in deren Projekt.' };
        })),
      tool('session_send', 'Schickt einer anderen Session einen Prompt (wird eingereiht, falls sie gerade arbeitet).',
        { session: z.string(), prompt: z.string() },
        wrap(async ({ session, prompt }) => {
          const p = await target(session);
          const r = await ctx.runners.get(p.id);
          await r.send(`[Nachricht von Session „${projectId}“]\n${prompt}`, { source: projectId });
          return { gesendet: true, status: r.state };
        })),
      tool('session_status', 'Status einer anderen Session und ihr letztes Ergebnis.', { session: z.string() },
        wrap(async ({ session }) => {
          const p = await target(session);
          const r = ctx.runners.peek(p.id);
          return { id: p.id, status: r?.state ?? 'idle', offeneFreigaben: r?.pending.size ?? 0, letztesErgebnis: short(r?.lastResult), kostenUsd: r?.stats ? Math.round(r.stats.costUsd * 1000) / 1000 : 0 };
        })),
      tool('session_wait', 'Wartet, bis eine andere Session ihre aktuelle Aufgabe beendet hat, und liefert das Ergebnis. Kehrt früher zurück, wenn sie auf eine Freigabe des Nutzers wartet.',
        { session: z.string(), timeoutSeconds: z.number().int().min(5).max(1800).optional() },
        wrap(async ({ session, timeoutSeconds }) => {
          const p = await target(session);
          const r = await ctx.runners.get(p.id);
          const w = await r.waitIdle((timeoutSeconds ?? 600) * 1000);
          return { id: p.id, fertig: w.done, wartetAufFreigabe: !!w.waitingForApproval, status: r.state, ergebnis: short(w.result) };
        })),
      tool('session_stop', 'Beendet den Claude-Prozess einer anderen Session (Verlauf bleibt erhalten).', { session: z.string() },
        wrap(async ({ session }) => {
          const p = await target(session);
          await ctx.runners.peek(p.id)?.stop('parent');
          return { gestoppt: p.id };
        })),

      // ---- schedules
      tool('schedule_create', 'Zeitplan: sendet einen Prompt automatisch an eine Session – einmalig (kind "at", ISO-Zeit), alle n Minuten ("every") oder per Cron ("cron", 5 Felder, Ortszeit, z. B. "0 9 * * 1-5"). Ohne session = diese Session.',
        {
          prompt: z.string(), kind: z.enum(['at', 'every', 'cron']), name: z.string().optional(), session: z.string().optional(),
          at: z.string().optional().describe('ISO-Zeit, z. B. 2026-11-23T09:00'), everyMinutes: z.number().int().optional(), cron: z.string().optional(),
        },
        wrap(async ({ session, ...s }) => ctx.schedules.create(session?.trim() || projectId, s, `Claude (${projectId})`))),
      tool('schedule_list', 'Zeitpläne – alle oder einer Session.', { session: z.string().optional() },
        wrap(async ({ session }) => ctx.schedules.list(session?.trim() || undefined).map((s) => ({ ...s, nextRun: s.nextRun ? new Date(s.nextRun).toISOString() : null, lastRun: s.lastRun ? new Date(s.lastRun).toISOString() : null })))),
      tool('schedule_update', 'Ändert einen Zeitplan (z. B. enabled: false zum Pausieren).',
        { id: z.string(), enabled: z.boolean().optional(), prompt: z.string().optional(), name: z.string().optional(), cron: z.string().optional(), everyMinutes: z.number().int().optional(), at: z.string().optional() },
        wrap(async ({ id, ...patch }) => ctx.schedules.update(id, patch))),
      tool('schedule_delete', 'Löscht einen Zeitplan.', { id: z.string() }, wrap(async ({ id }) => { await ctx.schedules.remove(id); return { gelöscht: id }; })),
    ],
  });
}
