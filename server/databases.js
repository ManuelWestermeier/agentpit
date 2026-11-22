import fs from 'node:fs';
import path from 'node:path';
import { UserError, slugify } from './util.js';

const TYPES = ['sqlite', 'postgres', 'mysql'];
const MAX_ROWS = 500;
const TIMEOUT_MS = 30_000;

function shapeRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const columns = list.length ? Object.keys(list[0]) : [];
  return {
    columns,
    rows: list.slice(0, MAX_ROWS).map((r) => columns.map((c) => {
      const v = r[c];
      if (v == null) return null;
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Date) return v.toISOString();
      if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `<${v.length} Bytes>`;
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    })),
    rowCount: list.length,
    truncated: list.length > MAX_ROWS,
  };
}

/**
 * Database connections per project (credentials stay in DATA_DIR, never in the project folder).
 * Used by the UI query console and by Claude through the cockpit MCP server.
 * Read queries run inside read-only transactions / read-only handles.
 */
export class Databases {
  constructor(ctx) { this.ctx = ctx; }

  file(projectId) { return this.ctx.store.p('db', `${projectId}.json`); }

  async list(projectId, { secrets = false } = {}) {
    const all = await this.ctx.store.readJson(this.file(projectId), []);
    return all.map((c) => (secrets ? c : { ...c, url: c.url ? c.url.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:•••@') : c.url }));
  }

  async #get(projectId, id) {
    const c = (await this.list(projectId, { secrets: true })).find((x) => x.id === id);
    if (!c) throw new UserError(`Verbindung „${id}“ existiert nicht`);
    return c;
  }

  async save(projectId, input) {
    const all = await this.list(projectId, { secrets: true });
    if (!TYPES.includes(input.type)) throw new UserError('Typ: sqlite, postgres oder mysql');
    const name = String(input.name ?? '').trim().slice(0, 60);
    if (!name) throw new UserError('Name fehlt');
    const existing = input.id ? all.find((c) => c.id === input.id) : null;
    const id = existing?.id ?? (() => { let base = slugify(name), id = base; for (let i = 2; all.some((c) => c.id === id); i++) id = `${base}-${i}`; return id; })();
    const conn = { id, name, type: input.type, writable: input.writable === true, note: String(input.note ?? '').slice(0, 500) };
    if (input.type === 'sqlite') {
      const p = String(input.file ?? '').trim();
      if (!p) throw new UserError('Pfad zur SQLite-Datei fehlt');
      conn.file = p;
    } else {
      let url = String(input.url ?? '').trim();
      if (existing && url.includes('•••')) url = existing.url; // masked value sent back unchanged
      if (!/^(postgres(ql)?|mysql):\/\//.test(url)) throw new UserError('URL im Format postgres://user:pass@host:5432/db bzw. mysql://…');
      conn.url = url;
    }
    const next = existing ? all.map((c) => (c.id === id ? conn : c)) : [...all, conn];
    await this.ctx.store.writeJson(this.file(projectId), next);
    return { ...conn, url: conn.url ? conn.url.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:•••@') : undefined };
  }

  async remove(projectId, id) {
    const all = await this.list(projectId, { secrets: true });
    await this.ctx.store.writeJson(this.file(projectId), all.filter((c) => c.id !== id));
  }

  #sqlitePath(projectId, file) {
    return path.isAbsolute(file) ? file : path.join(this.ctx.projects.dirOf(projectId), file);
  }

  /** Runs SQL. mode 'read' enforces read-only, 'write' requires the connection to allow writes. */
  async run(projectId, id, sql, mode = 'read') {
    const c = await this.#get(projectId, id);
    const text = String(sql ?? '').trim();
    if (!text) throw new UserError('SQL fehlt');
    if (text.length > 100_000) throw new UserError('SQL zu lang');
    if (mode === 'write' && !c.writable) throw new UserError(`Verbindung „${c.name}“ ist schreibgeschützt (im Cockpit unter Daten freigeben)`);
    const started = Date.now();
    let result;
    if (c.type === 'sqlite') result = await this.#sqlite(projectId, c, text, mode);
    else if (c.type === 'postgres') result = await this.#postgres(c, text, mode);
    else result = await this.#mysql(c, text, mode);
    return { ...result, ms: Date.now() - started };
  }

  async #sqlite(projectId, c, sql, mode) {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import('node:sqlite')); } catch {
      throw new UserError('SQLite braucht Node.js ≥ 22.13 (aktuelle LTS installieren)');
    }
    const file = this.#sqlitePath(projectId, c.file);
    if (mode === 'read' && !fs.existsSync(file)) throw new UserError(`Datei nicht gefunden: ${file}`);
    let db;
    try { db = new DatabaseSync(file, { readOnly: mode === 'read' }); } catch (e) { throw new UserError(e.message); }
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma|explain)\b/i.test(sql)) return shapeRows(stmt.all());
      const info = stmt.run();
      return { columns: ['changes', 'lastInsertRowid'], rows: [[Number(info.changes), String(info.lastInsertRowid)]], rowCount: 1, truncated: false };
    } catch (e) {
      throw new UserError(/readonly/i.test(e.message) ? 'Nur lesender Zugriff – zum Schreiben die Verbindung freigeben und „Schreiben“ nutzen' : e.message);
    } finally { db.close(); }
  }

  async #postgres(c, sql, mode) {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: c.url, statement_timeout: TIMEOUT_MS, query_timeout: TIMEOUT_MS + 2000, connectionTimeoutMillis: 10_000 });
    await client.connect();
    try {
      await client.query(mode === 'read' ? 'BEGIN READ ONLY' : 'BEGIN');
      const r = await client.query({ text: sql, rowMode: 'object' });
      const last = Array.isArray(r) ? r[r.length - 1] : r;
      await client.query(mode === 'read' ? 'ROLLBACK' : 'COMMIT');
      return last.rows?.length || last.fields?.length ? shapeRows(last.rows) : { columns: ['rowCount'], rows: [[last.rowCount ?? 0]], rowCount: 1, truncated: false };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw new UserError(e.message);
    } finally { await client.end().catch(() => {}); }
  }

  async #mysql(c, sql, mode) {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({ uri: c.url, connectTimeout: 10_000, multipleStatements: false, dateStrings: true });
    try {
      await conn.query(mode === 'read' ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION');
      const [rows] = await conn.query({ sql, timeout: TIMEOUT_MS });
      await conn.query(mode === 'read' ? 'ROLLBACK' : 'COMMIT');
      return Array.isArray(rows) ? shapeRows(rows) : { columns: ['affectedRows', 'insertId'], rows: [[rows.affectedRows, rows.insertId]], rowCount: 1, truncated: false };
    } catch (e) {
      await conn.query('ROLLBACK').catch(() => {});
      throw new UserError(e.message);
    } finally { await conn.end().catch(() => {}); }
  }

  /** Tables and columns, compact enough for Claude's context. */
  async schema(projectId, id) {
    const c = await this.#get(projectId, id);
    if (c.type === 'sqlite') {
      const tables = await this.run(projectId, id, "SELECT name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
      return tables.rows.map(([name, sql]) => `${name}: ${sql}`).join('\n') || '(keine Tabellen)';
    }
    const sql = c.type === 'postgres'
      ? "SELECT table_schema||'.'||table_name AS t, string_agg(column_name||' '||data_type, ', ' ORDER BY ordinal_position) AS cols FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') GROUP BY 1 ORDER BY 1"
      : "SELECT table_name AS t, GROUP_CONCAT(CONCAT(column_name,' ',column_type) ORDER BY ordinal_position SEPARATOR ', ') AS cols FROM information_schema.columns WHERE table_schema = DATABASE() GROUP BY table_name ORDER BY table_name";
    const r = await this.run(projectId, id, sql);
    return r.rows.map(([t, cols]) => `${t}(${cols})`).join('\n') || '(keine Tabellen)';
  }
}
