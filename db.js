// ════════════════════════════════════════════════════════════
//  MA CRM — db.js : one database interface, two engines.
//    DATABASE_URL set  → Supabase / Postgres (permanent, survives redeploys)
//    DATABASE_URL empty → local SQLite file (old behaviour, for local use)
//  The rest of the app keeps calling dbRun / dbGet / dbAll with "?" placeholders.
//    dbRun → { changes, lastID }    dbGet → row | undefined    dbAll → rows[]
// ════════════════════════════════════════════════════════════
const path = require('path');

module.exports = function createDb({ dataDir }) {
  const url = (process.env.DATABASE_URL || '').trim();

  // ── POSTGRES ────────────────────────────────────────────
  if (url) {
    const { Pool, types } = require('pg');
    // bigint / numeric come back as numbers (SQLite did this); timestamps stay plain text
    types.setTypeParser(20, v => Number(v));
    types.setTypeParser(1700, v => Number(v));
    types.setTypeParser(1114, v => v);
    types.setTypeParser(1184, v => v);

    const pool = new Pool({
      connectionString: url,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX) || 8,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });
    pool.on('error', e => console.error('[db] idle client error:', e.message));

    // "?" → $1, $2 … (skips anything inside '...' string literals)
    function toPg(sql) {
      let out = '', n = 0, inStr = false;
      for (let i = 0; i < sql.length; i++) {
        const c = sql[i];
        if (c === "'") inStr = !inStr;
        out += (!inStr && c === '?') ? '$' + (++n) : c;
      }
      return out;
    }
    const needsId = sql => /^\s*INSERT\s+INTO\s+(users|orders|clients|order_screenshots)\b/i.test(sql) && !/\bRETURNING\b/i.test(sql);

    return {
      engine: 'postgres',
      label: 'Supabase Postgres',
      async dbRun(sql, p = []) {
        const q = needsId(sql) ? sql.replace(/;?\s*$/, ' RETURNING id') : sql;
        const r = await pool.query(toPg(q), p);
        return { changes: r.rowCount, lastID: r.rows && r.rows[0] ? r.rows[0].id : undefined };
      },
      async dbGet(sql, p = []) { return (await pool.query(toPg(sql), p)).rows[0]; },
      async dbAll(sql, p = []) { return (await pool.query(toPg(sql), p)).rows; },
      // dialect helpers for the CREATE TABLE statements
      t: { id: 'SERIAL PRIMARY KEY', ts: 'TIMESTAMP', real: 'DOUBLE PRECISION', big: 'BIGINT' },
      async addColumn(table, def) { await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${def}`); },
      async init() { await pool.query('SELECT 1'); },
      // Supabase exposes the public schema through its web API. Turn Row Level Security ON for every
      // table (no policies = the public API can read nothing); this server connects as the owner
      // role, which is not affected, so the CRM keeps working.
      async secure() {
        const { rows } = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`);
        for (const r of rows) await pool.query(`ALTER TABLE public."${r.tablename.replace(/"/g, '""')}" ENABLE ROW LEVEL SECURITY`);
        return rows.length;
      },
      close: () => pool.end(),
    };
  }

  // ── SQLITE (fallback) ───────────────────────────────────
  const sqlite3 = require('sqlite3').verbose();
  const file = path.join(dataDir, 'macrm.db');
  const db = new sqlite3.Database(file, err => {
    if (err) { console.error('❌ DB Error:', err.message); process.exit(1); }
  });
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res({ changes: this.changes, lastID: this.lastID }); }));
  return {
    engine: 'sqlite',
    label: 'SQLite ' + file,
    dbRun: run,
    dbGet: (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r))),
    dbAll: (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r))),
    t: { id: 'INTEGER PRIMARY KEY AUTOINCREMENT', ts: 'DATETIME', real: 'REAL', big: 'INTEGER' },
    async addColumn(table, def) {
      try { await run(`ALTER TABLE ${table} ADD COLUMN ${def}`); }
      catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
    },
    async init() { await run('PRAGMA journal_mode=WAL'); },
    async secure() { return 0; },
    close: () => new Promise(r => db.close(r)),
  };
};
