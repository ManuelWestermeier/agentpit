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

/** Tools that do not change anything – approved without asking. */
export const COCKPIT_SAFE_TOOLS = new Set(['db_connections', 'db_schema', 'db_query', 'services_list', 'service_logs', 'browser_info'].map((n) => `mcp__cockpit__${n}`));

/** In-process MCP server bound to one project: databases, services, linked browser. */
export function cockpitMcp(ctx, projectId) {
  const { databases, services, browsers, projects } = ctx;
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
      tool('browser_info', 'Welches Browser-Profil (Identität) mit dieser Session verknüpft ist und was gerade geöffnet ist.', {},
        wrap(async () => {
          const p = await projects.get(projectId);
          if (!p.browserProfile) return 'Kein Profil verknüpft – Playwright nutzt einen eigenen, isolierten Browser.';
          const prof = browsers.list().find((b) => b.id === p.browserProfile);
          return prof ? { profil: prof.name, läuft: prof.running, url: prof.url, titel: prof.title, hinweis: 'Der Nutzer sieht diesen Browser live und kann eingreifen. Logins bleiben im Profil gespeichert.' } : 'Profil nicht gefunden';
        })),
    ],
  });
}
