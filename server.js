// ════════════════════════════════════════════════════════════
//  MA CRM — Node.js + SQLite Backend
//  Version: 1.5 (WhatsApp in the SAME browser via extension — no separate browser)
//  Run: node server.js
//  URL: http://localhost:3000
// ════════════════════════════════════════════════════════════

const express  = require('express');
const sqlite3  = require('sqlite3').verbose();
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');

// ── .env — GEMINI_API_KEY yahan rakhein, code mein nahi ────────
// Own small reader so it works on every Node version and forgives
// common Windows mistakes: Notepad saving ".env.txt", a browser saving
// the download as "env" or "_env", UTF-8 BOM, quotes, spaces around "=".
const ENV_CANDIDATES = ['.env', '.env.txt', 'env', 'env.txt', '_env', '_env.txt', '.env.example'];
function readEnvFile(file) {
  const out = {};
  let text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1].toUpperCase()] = v;
  }
  return out;
}
const envInfo = { file: null, fromEnvVar: false, notes: [] };
(function loadEnv() {
  if ((process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim()) envInfo.fromEnvVar = true;
  for (const name of ENV_CANDIDATES) {
    const file = path.join(__dirname, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    let vars;
    try { vars = readEnvFile(file); } catch (e) { envInfo.notes.push(`${name} read nahi hui: ${e.message}`); continue; }
    const hasKey = !!(vars.GEMINI_API_KEY || vars.GOOGLE_API_KEY);
    if (name === '.env.example' && !hasKey) continue;   // untouched example file
    if (!envInfo.file) {
      envInfo.file = name;
      for (const [k, v] of Object.entries(vars)) {
        const cur = (process.env[k] || '').trim();
        if (!cur) process.env[k] = v;
        else if (/API_KEY$/.test(k) && v && cur !== v) envInfo.notes.push(`Windows/system environment variable ${k} "${name}" wali key se alag hai — environment variable wali use ho rahi hai`);
      }
      if (name !== '.env') envInfo.notes.push(`"${name}" se settings li gayin — behtar hai file ka naam ".env" rakhein`);
    } else if (hasKey) {
      envInfo.notes.push(`"${name}" bhi mili lekin use nahi hui ("${envInfo.file}" pehle mili)`);
    }
  }
})();
const ai = require('./ai-import');
const phoneUtil   = require('./phone');
const waSender    = require('./whatsapp-sender');
const createWaFlow = require('./whatsapp-workflow');
const rbac        = require('./rbac');
const keyCheck = ai.cleanApiKey(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '');
const GEMINI_API_KEY = keyCheck.key;
// ── Backup AI providers (used automatically when the main Gemini key is busy / out of quota) ──
//   GEMINI_API_KEY_2, GEMINI_API_KEY_3 = extra Gemini keys (best: from a DIFFERENT Google account/project)
//   NVIDIA_API_KEY = free key from build.nvidia.com; NVIDIA_MODEL default nvidia/muse-glimmer-30b (reads images)
const GEMINI_KEYS = [GEMINI_API_KEY, ...['GEMINI_API_KEY_2', 'GEMINI_API_KEY_3'].map(n => ai.cleanApiKey(process.env[n] || '').key)]
  .filter((k, i, arr) => k && arr.indexOf(k) === i);
const NVIDIA_API_KEY = String(process.env.NVIDIA_API_KEY || '').replace(/^\uFEFF/, '').trim().replace(/^["']+|["']+$/g, '').split(/\s+/)[0] || '';
const NVIDIA_MODEL = (process.env.NVIDIA_MODEL || 'nvidia/muse-glimmer-30b').trim();
const NVIDIA_BASE_URL = (process.env.NVIDIA_BASE_URL || ai.NVIDIA_BASE_DEFAULT).trim();
const AI_ENABLED = !!(GEMINI_KEYS.length || NVIDIA_API_KEY);
const GEMINI_MODEL   = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim().replace(/^models\//, '');
// Backup models used only when the main model is busy (HTTP 503 "high demand").
// Stable (GA) models by default; override in .env with GEMINI_FALLBACK_MODELS=a,b
const GEMINI_FALLBACK_MODELS = String(process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.6-flash,gemini-3.5-flash-lite')
  .split(',').map(m => m.trim().replace(/^models\//, '')).filter(m => m && m !== GEMINI_MODEL);
// Result of the startup key check, shown in the Import modal
let aiHealth = { state: GEMINI_API_KEY ? 'checking' : 'off', message: '' };

const app  = express();
const PORT = Number(process.env.PORT) || 3000;
// Keep the SQLite database and screenshot uploads together on a persistent disk.
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
fs.mkdirSync(DATA_DIR, { recursive: true });

// APIs are same-origin; never expose unrestricted cross-origin credentials.
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '10mb' }));

// Shared phone utility — the review form loads the SAME file the server uses
app.get('/lib/phone.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'phone.js')));

// ── REPORT PAGE (must be BEFORE static middleware) ───────────
app.get('/report', (req, res) => {
  const reportPath = path.join(__dirname, 'public', 'report.html');
  if (fs.existsSync(reportPath)) {
    res.sendFile(reportPath);
  } else {
    res.status(404).json({ error: 'report.html nahi mila. public/ folder mein rakho.' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE SETUP ──────────────────────────────────────────
// DATABASE_URL set → Supabase Postgres (permanent). Not set → local SQLite file.
const DB = require('./db')({ dataDir: DATA_DIR });
const { dbRun, dbGet, dbAll, t: T } = DB;
console.log('✅ Database engine →', DB.label);

const auth = require('./auth')({ dbRun, dbGet });
// Public access is protected with cookie sessions; turn on private networking explicitly if desired.
if (process.env.CRM_PRIVATE_NETWORK === '1') app.use(auth.network);
app.use(auth.gate);
// Adds a column to an existing database; "already exists" is the normal case and is ignored.
const addColumn = (table, def) => DB.addColumn(table, def).catch(e => console.warn(`⚠ Column "${def}" add nahi hua:`, e.message));

// ── ORIGINAL ORDER SCREENSHOTS (stored byte-for-byte, never resized) ──
// order-screenshots/tmp/<id>      uploaded, order not placed yet (auto-deleted after 24h)
// order-screenshots/orders/<n>/   belongs to order #n — this exact file is sent on WhatsApp
const SS_ROOT = path.join(DATA_DIR, 'order-screenshots');
const SS_TMP  = path.join(SS_ROOT, 'tmp');
fs.mkdirSync(SS_TMP, { recursive: true });
fs.mkdirSync(path.join(SS_ROOT, 'orders'), { recursive: true });

const storage = require('./storage')();
console.log('✅ Screenshot storage →', storage.enabled ? `Supabase bucket "${storage.bucket}" (permanent)` : 'local disk only (set SUPABASE_URL + SUPABASE_SERVICE_KEY for permanent copies)');

const waFlow = createWaFlow({
  dbRun, dbGet, dbAll,
  screenshotRoot: SS_ROOT,
  ensureFile: fileName => storage.ensureLocal(SS_ROOT, fileName),
  gemini: {
    apiKey: GEMINI_API_KEY || GEMINI_KEYS[0] || '',
    apiKeys: GEMINI_KEYS,
    nvidia: NVIDIA_API_KEY ? { apiKey: NVIDIA_API_KEY, model: NVIDIA_MODEL, baseUrl: NVIDIA_BASE_URL } : null,
    models: [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS],
    language: (process.env.WHATSAPP_MESSAGE_LANGUAGE || 'English').trim(),
    // Message wording comes from whatsapp-message.txt. WHATSAPP_MESSAGE=gemini → let Gemini write it instead.
    mode: /^gemini$/i.test(String(process.env.WHATSAPP_MESSAGE || '').trim()) ? 'gemini' : 'template',
  },
});
const BUSINESS_NAME = (process.env.BUSINESS_NAME || '').trim();

// ── CREATE TABLES ───────────────────────────────────────────
async function initDB() {
  await DB.init();

  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id         ${T.id},
      name       TEXT    NOT NULL,
      email      TEXT    UNIQUE NOT NULL,
      password   TEXT    NOT NULL,
      role       TEXT    DEFAULT 'staff',
      photo      TEXT,
      created_at ${T.ts} DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS orders (
      id          ${T.id},
      name        TEXT    NOT NULL,
      phone       TEXT    NOT NULL,
      detail      TEXT    DEFAULT '',
      amount      ${T.real} NOT NULL,
      advance     ${T.real} DEFAULT 0,
      status      TEXT    DEFAULT 'Processing',
      assigned_to INTEGER DEFAULT 1,
      tracking_id TEXT    DEFAULT '',
      date        TEXT    NOT NULL,
      month       INTEGER NOT NULL,
      year        INTEGER NOT NULL,
      created_at  ${T.ts} DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add tracking_id to existing databases that were created before this column existed
  await addColumn('orders', `tracking_id TEXT DEFAULT ''`);

  // Clients saved without an order ("Save Client Only") + audit trail.
  // Existing orders keep working unchanged: client_id stays NULL and
  // source defaults to 'manual' for every row that already exists.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS clients (
      id         ${T.id},
      name       TEXT    NOT NULL,
      phone      TEXT    DEFAULT '',
      email      TEXT    DEFAULT '',
      address    TEXT    DEFAULT '',
      notes      TEXT    DEFAULT '',
      source     TEXT    DEFAULT 'manual',
      created_at ${T.ts} DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await addColumn('orders', `client_id INTEGER`);
  await addColumn('orders', `source TEXT DEFAULT 'manual'`);

  // WhatsApp order confirmation (only ever written by whatsapp-workflow.js)
  for (const col of [
    `address TEXT DEFAULT ''`,
    `workflow_state TEXT`,          // ORDER_PLACED → WHATSAPP_PENDING → WHATSAPP_OPENED → WHATSAPP_SENT | WHATSAPP_FAILED
    `wa_status TEXT`,               // NULL | pending | processing | sent | failed
    `wa_phone TEXT`,                // normalized number the message goes to
    `wa_snapshot TEXT`,             // order data frozen at Place Order — the message is built from this
    `wa_message TEXT`,
    `wa_message_source TEXT`,       // gemini | standard | manual
    `wa_step TEXT`, `wa_progress TEXT`, `wa_error TEXT`, `wa_error_code TEXT`,
    `wa_parts_sent INTEGER DEFAULT 0`, `wa_attempts INTEGER DEFAULT 0`,
    `wa_started_at ${T.ts}`, `wa_sent_at ${T.ts}`,
  ]) await addColumn('orders', col);

  // Order Placed Date + VPL 3-day reminder. Purely additive: every existing order keeps
  // NULL / 0 in these columns, so no old data is overwritten with a guessed date.
  for (const col of [
    `placed_date TEXT`,                       // YYYY-MM-DD, stamped by the server when the order is placed
    `shipped_date TEXT`,                      // YYYY-MM-DD, stamped when a VPL tracking ID is first saved
    `vpl_reminder_sent INTEGER DEFAULT 0`,    // 0 = NO, 1 = YES
    `vpl_reminder_sent_at ${T.ts}`,
    `vpl_reminder_error TEXT`,                // only set when a send's outcome is unknown (never auto-retried)
  ]) await addColumn('orders', col);

  // ── STAFF ACCESS / RBAC (purely additive — existing rows keep working unchanged) ──
  //   users.permissions      JSON text of the Staff permissions the Admin ticked (admin ignores it)
  //   orders.created_by      user id that placed the order (NULL for orders placed before this update)
  //   orders.created_by_role 'admin' | 'staff' at the moment of placing (survives a staff account delete)
  //   orders.updated_by/_at  last user who edited / changed status / changed tags
  //   orders.tags            comma-separated order tags ('' = none)
  await addColumn('users', `permissions TEXT`);
  for (const col of [
    `created_by INTEGER`, `created_by_role TEXT`, `updated_by INTEGER`, `updated_at TEXT`, `tags TEXT DEFAULT ''`,
  ]) await addColumn('orders', col);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS order_activity (
      id         ${T.id},
      order_id   INTEGER NOT NULL,
      user_id    INTEGER,
      user_role  TEXT,
      user_name  TEXT,
      action     TEXT    NOT NULL,
      detail     TEXT    DEFAULT '',
      created_at TEXT    NOT NULL
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_order_activity_user ON order_activity(user_id)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_order_activity_order ON order_activity(order_id)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_orders_created_by ON orders(created_by)`);
  // Staff accounts that existed before this update keep what they could already do
  // (see rbac.LEGACY_STAFF). Runs only for staff rows that have no permissions saved yet.
  const legacy = await dbRun(`UPDATE users SET permissions=? WHERE role='staff' AND (permissions IS NULL OR permissions='')`,
    [rbac.serialize(rbac.LEGACY_STAFF)]);
  if (legacy.changes) console.log(`🔐 ${legacy.changes} existing staff account(s) given their previous access as permissions`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS order_screenshots (
      id            ${T.id},
      order_id      INTEGER NOT NULL,
      position      INTEGER NOT NULL,
      file_name     TEXT    NOT NULL,
      original_name TEXT    DEFAULT '',
      mime          TEXT    NOT NULL,
      bytes         INTEGER NOT NULL,
      sha256        TEXT    NOT NULL,
      created_at    ${T.ts} DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_order_screenshots_order ON order_screenshots(order_id)`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Hash any passwords left in an older local database. Never ship a default password.
  const oldUsers = await dbAll(`SELECT id, password FROM users`);
  for (const u of oldUsers) {
    if (!auth.isHashed(u.password)) {
      await dbRun(`UPDATE users SET password=? WHERE id=?`, [auth.hashPassword(u.password), u.id]);
    }
  }
  const adminExists = await dbGet(`SELECT id FROM users WHERE role='admin' LIMIT 1`);
  if (!adminExists) {
    const email = (process.env.ADMIN_EMAIL || '').trim();
    const password = process.env.ADMIN_PASSWORD || '';
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 12) {
      throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters) as private hosting environment variables before starting MA CRM.');
    }
    await dbRun(`INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)`,
      [(process.env.ADMIN_NAME || 'CRM Admin').trim(), email, auth.hashPassword(password), 'admin']);
    console.log('✅ Initial admin account created securely');
  }
  await auth.init();
  try { const n = await DB.secure(); if (DB.engine === 'postgres') console.log(`🔒 Row Level Security ON for ${n} tables`); }
  catch (e) { console.warn('⚠ RLS enable nahi hua:', e.message); }
  console.log('✅ Database tables ready');
}

// ════════════════════════════════════════════════════════════
//  API ROUTES
// ════════════════════════════════════════════════════════════

// ── AUTH: LOGIN / SERVER-SIDE SESSIONS ────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const ip = req.ip || req.socket.remoteAddress || '';
    if (!auth.loginAllowed(ip)) return res.status(429).json({ success: false, message: 'Too many login attempts. Try again later.' });
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password)
      return res.status(400).json({ success: false, message: 'Email and password required.' });
    const user = await dbGet(`SELECT id, name, email, role, photo, password, permissions FROM users WHERE LOWER(email)=LOWER(?) LIMIT 1`, [email.trim()]);
    if (!user || !auth.verifyPassword(password, user.password)) {
      auth.loginFailed(ip);
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }
    auth.loginOk(ip);
    await auth.createSession(res, user);
    res.json({ success: true, user: { id:user.id, name:user.name, email:user.email, role:user.role, photo:user.photo || null,
      permissions: user.role === 'admin' ? null : rbac.parse(user.permissions) } });
  } catch (e) {
    console.error('[login]', e.message);
    res.status(500).json({ success:false, message:'Login could not be completed.' });
  }
});
app.get('/api/me', (req, res) => res.json({ success:true, user:req.user }));
app.post('/api/logout', async (req, res) => {
  await auth.destroySession(req, res);
  res.json({ success:true });
});

app.post('/api/change-password', async (req, res) => {
  try {
    const { userId, newPassword } = req.body || {};
    if (req.user.role !== 'admin' || Number(userId) !== req.user.id)
      return res.status(403).json({ success:false, message:'You may only change your own admin password.' });
    if (typeof newPassword !== 'string' || newPassword.length < 12)
      return res.status(400).json({ success:false, message:'Password must have at least 12 characters.' });
    await dbRun(`UPDATE users SET password=? WHERE id=?`, [auth.hashPassword(newPassword), req.user.id]);
    await dbRun(`DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY last_seen DESC LIMIT 1)`, [req.user.id, req.user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success:false, message:'Password update failed.' }); }
});

// ── USERS: GET ALL ──────────────────────────────────────────
app.get('/api/users', async (req, res) => {
  try {
    const rows = await dbAll(`SELECT id, name, email, role, photo, permissions FROM users ORDER BY role DESC, id ASC`);
    const admin = rbac.isAdmin(req.user);
    // Staff only get names/photos of colleagues (for "handled by" labels) — no emails, no permissions.
    const users = rows.map(u => {
      const out = { id: u.id, name: u.name, role: u.role, photo: u.photo };
      if (admin || u.id === req.user.id) {
        out.email = u.email;
        if (u.role !== 'admin') out.permissions = rbac.parse(u.permissions);
      }
      return out;
    });
    if (!admin) return res.json({ success: true, users });
    res.json({ success: true, users, permissionCatalog: rbac.PERMISSIONS, adminOnlyFeatures: rbac.ADMIN_ONLY_FEATURES });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── USERS: UPDATE PROFILE ───────────────────────────────────
app.post('/api/users/update', async (req, res) => {
  try {
    const { id, name, email, photo } = req.body;
    if (!id || !name) return res.json({ success: false, message: 'id aur name required hai' });
    if (Number(id) !== req.user.id) return res.status(403).json({ success: false, message: 'You may edit only your own profile.' });
    await dbRun(
      `UPDATE users SET name=?, email=?, photo=? WHERE id=?`,
      [name.trim(), (email||'').trim(), photo||null, id]
    );
    const updated = await dbGet(`SELECT id,name,email,role,photo FROM users WHERE id=?`,[id]);
    res.json({ success: true, user: updated });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── STAFF: ADD ──────────────────────────────────────────────
app.post('/api/staff/add', async (req, res) => {
  try {
    const { name, email, password, photo } = req.body;
    if (!name || !email || !password) return res.json({ success: false, message: 'Name, email, password required hai' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ success:false, message:'Staff password must be at least 8 characters.' });

    const exists = await dbGet(`SELECT id FROM users WHERE LOWER(email)=LOWER(?) LIMIT 1`, [email.trim()]);
    if (exists) return res.json({ success: false, message: 'Yeh email pehle se registered hai' });

    const perms = (req.body.permissions && typeof req.body.permissions === 'object') ? req.body.permissions : rbac.NEW_STAFF_DEFAULT;
    const result = await dbRun(
      `INSERT INTO users (name, email, password, role, photo, permissions) VALUES (?,?,?,?,?,?)`,
      [name.trim(), email.trim(), auth.hashPassword(password), 'staff', photo||null, rbac.serialize(perms)]
    );
    const newUser = await dbGet(`SELECT id,name,email,role,photo,permissions FROM users WHERE id=?`,[result.lastID]);
    newUser.permissions = rbac.parse(newUser.permissions);
    res.json({ success: true, user: newUser });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── STAFF: UPDATE ───────────────────────────────────────────
app.post('/api/staff/update', async (req, res) => {
  try {
    const { id, name, email, password, photo } = req.body;
    if (!id) return res.json({ success: false, message: 'id required hai' });

    if (password && password.trim()) {
      if (password.length < 8) return res.status(400).json({ success:false, message:'Staff password must be at least 8 characters.' });
      await dbRun(`UPDATE users SET name=?, email=?, password=?, photo=? WHERE id=? AND role='staff'`,
        [name, email, auth.hashPassword(password), photo||null, id]);
    } else {
      await dbRun(`UPDATE users SET name=?, email=?, photo=? WHERE id=? AND role='staff'`,
        [name, email, photo||null, id]);
    }
    // Permissions: only when the Admin sends them (older callers without the field keep the current ones)
    if (req.body.permissions && typeof req.body.permissions === 'object') {
      await dbRun(`UPDATE users SET permissions=? WHERE id=? AND role='staff'`, [rbac.serialize(req.body.permissions), id]);
    }
    const updated = await dbGet(`SELECT id,name,email,role,photo,permissions FROM users WHERE id=?`,[id]);
    if (updated) updated.permissions = updated.role === 'admin' ? null : rbac.parse(updated.permissions);
    res.json({ success: true, user: updated });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── STAFF: DELETE ───────────────────────────────────────────
app.delete('/api/staff/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const del = await dbRun(`DELETE FROM users WHERE id=? AND role='staff'`, [id]);
    if (del.changes) await dbRun(`DELETE FROM sessions WHERE user_id=?`, [id]).catch(() => {});   // signed out everywhere
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── ORDER ACTIVITY / OWNERSHIP HELPERS (Staff access) ───────
// Activity log is best-effort: a logging failure never blocks or undoes an order change.
async function logActivity(orderId, user, action, detail = '') {
  try {
    await dbRun(`INSERT INTO order_activity (order_id, user_id, user_role, user_name, action, detail, created_at) VALUES (?,?,?,?,?,?,?)`,
      [orderId, user ? user.id : null, user ? user.role : null, user ? user.name : null, action, String(detail || '').slice(0, 300), new Date().toISOString()]);
  } catch (e) { console.warn(`[activity] #${orderId} ${action}:`, e.message); }
}
async function stampUpdate(orderId, user) {
  try { await dbRun(`UPDATE orders SET updated_by=?, updated_at=? WHERE id=?`, [user.id, new Date().toISOString(), orderId]); }
  catch (e) { console.warn(`[orders] #${orderId} updated_by save fail:`, e.message); }
}
const forbid = (res, message) => res.status(403).json({ success: false, code: 'forbidden', message });
const tagsOf = o => String((o && o.tags) || '').split(',').map(t => t.trim()).filter(Boolean);

// ── ORDERS: GET ALL ─────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await dbAll(`SELECT o.*, (SELECT COUNT(*) FROM order_screenshots s WHERE s.order_id=o.id) AS screenshot_count
                                FROM orders o ORDER BY o.id ASC`);
    res.json({ success: true, orders });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── ORDERS: ADD (manual form) ───────────────────────────────
// With `whatsapp` in the body (manual Place Order with screenshot) it goes through the
// SAME placeOrder() as AI orders → same WhatsApp. Without it (old callers) it just saves.
app.post('/api/orders/add', async (req, res) => {
  try {
    const { name, phone, detail, amount, advance, tracking_id, date, month, year, source } = req.body;
    let { status, assigned_to } = req.body;
    if (!name || !phone || !amount) return res.json({ success: false, message: 'Name, phone, amount required hai' });
    // Staff: the order is always theirs, and a starting status other than Processing needs that status permission
    if (!rbac.isAdmin(req.user)) {
      status = status || 'Processing';
      if (status !== 'Processing' && !rbac.canSetStatus(req.user, status))
        return forbid(res, `"${status}" status lagane ki permission nahi hai — order Processing mein place karein.`);
      assigned_to = req.user.id;
    }
    const tags = (req.body.tags !== undefined && rbac.can(req.user, 'change_tags')) ? rbac.cleanTags(req.body.tags) : '';
    const waIn = (req.body.whatsapp && typeof req.body.whatsapp === 'object') ? req.body.whatsapp : null;
    let whatsapp = null;
    if (waIn) {
      const phones = Array.isArray(req.body.phones) ? req.body.phones.map(String) : phoneUtil.split(phone);
      whatsapp = await checkWhatsAppOrder({ waIn, phones, lines: req.body.lines });
      if (!whatsapp.ok) return res.json({ success: false, code: 'validation', message: whatsapp.message });
    }
    const out = await placeOrder({
      name, phone, detail, amount, advance, status, assigned_to, tracking_id, date, month, year,
      source: source === 'ai_screenshot' ? 'ai_screenshot' : 'manual',
      tags, created_by: req.user.id, created_by_role: req.user.role,
    }, { address: cleanAddress(req.body.address), whatsapp });
    await logActivity(out.order.id, req.user, 'created', `${out.order.status || 'Processing'} · Rs ${Number(out.order.amount) || 0}`);
    res.json({ success: true, order: out.order, whatsapp: { started: out.waStarted } });
  } catch (e) {
    console.error('[orders/add]', e.stack || e.message);
    res.json({ success: false, code: 'save_failed', message: 'Order could not be saved. WhatsApp was not opened.', detail: e.message });
  }
});

// ── ORDERS: UPDATE STATUS ───────────────────────────────────
app.post('/api/orders/status', async (req, res) => {
  try {
    const { id, status } = req.body;
    if (!id || !status) return res.json({ success: false, message: 'id aur status required hai' });
    const prev = await dbGet(`SELECT id, status FROM orders WHERE id=?`, [id]);
    if (!rbac.isAdmin(req.user)) {
      if (!prev) return res.json({ success: false, message: 'Order nahi mila' });
      if (prev.status === status) return res.json({ success: true, order: await dbGet(`SELECT * FROM orders WHERE id=?`, [id]) });
      if (!rbac.canSetStatus(req.user, status)) return forbid(res, `"${status}" status lagane ki permission nahi hai.`);
    }
    await dbRun(`UPDATE orders SET status=? WHERE id=?`, [status, id]);
    if (prev && prev.status !== status) {
      await stampUpdate(id, req.user);
      await logActivity(prev.id, req.user, 'status', `${prev.status || '—'} → ${status}`);
    }
    const updated = await dbGet(`SELECT * FROM orders WHERE id=?`,[id]);
    res.json({ success: true, order: updated });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── ORDERS: UPDATE FULL ORDER (Edit modal) ──────────────────
app.post('/api/orders/update', async (req, res) => {
  try {
    const { id, name, phone, detail, amount, advance, tracking_id } = req.body;
    let { status, assigned_to } = req.body;
    if (!id || !name || !phone || !amount) return res.json({ success: false, message: 'id, name, phone, amount required hai' });
    const prevRow = await dbGet(`SELECT * FROM orders WHERE id=?`, [id]).catch(() => null);
    const hasTags = Object.prototype.hasOwnProperty.call(req.body, 'tags');
    const newTags = hasTags ? rbac.cleanTags(req.body.tags) : null;
    if (!rbac.isAdmin(req.user)) {
      if (!prevRow) return res.json({ success: false, message: 'Order nahi mila' });
      status = status || prevRow.status;                    // a missing status never resets the order for staff
      if (status !== prevRow.status && !rbac.canSetStatus(req.user, status))
        return forbid(res, `"${status}" status lagane ki permission nahi hai.`);
      if (hasTags && newTags !== String(prevRow.tags || '') && !rbac.can(req.user, 'change_tags'))
        return forbid(res, 'Tags badalne ki permission nahi hai.');
      assigned_to = prevRow.assigned_to;                    // staff cannot re-assign orders
    }
    await dbRun(
      `UPDATE orders SET name=?, phone=?, detail=?, amount=?, advance=?, status=?, assigned_to=?, tracking_id=? WHERE id=?`,
      [name, phone, detail||'', amount, advance||0, status||'Processing', assigned_to||1, tracking_id||'', id]
    );
    if (hasTags) await dbRun(`UPDATE orders SET tags=? WHERE id=?`, [newTags, id]);
    await recordShipment(id, prevRow && prevRow.tracking_id, tracking_id)
      .catch(e => console.warn(`[orders/update] #${id} shipped_date save fail:`, e.message));
    if (prevRow) {
      await stampUpdate(id, req.user);
      const finalStatus = status || 'Processing';
      await logActivity(prevRow.id, req.user, 'edited', prevRow.status !== finalStatus ? `status ${prevRow.status || '—'} → ${finalStatus}` : 'order details');
    }
    const updated = await dbGet(`SELECT * FROM orders WHERE id=?`, [id]);
    res.json({ success: true, order: updated });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── ORDERS: CHANGE TAGS ─────────────────────────────────────
app.post('/api/orders/tags', async (req, res) => {
  try {
    const id = parseInt(req.body && req.body.id);
    if (!id) return res.json({ success: false, message: 'id required hai' });
    if (!rbac.can(req.user, 'change_tags')) return forbid(res, 'Tags badalne ki permission nahi hai.');
    const prev = await dbGet(`SELECT id, tags FROM orders WHERE id=?`, [id]);
    if (!prev) return res.json({ success: false, message: 'Order nahi mila' });
    const tags = rbac.cleanTags(req.body.tags);
    await dbRun(`UPDATE orders SET tags=? WHERE id=?`, [tags, id]);
    if (tags !== String(prev.tags || '')) {
      await stampUpdate(id, req.user);
      await logActivity(id, req.user, 'tags', tags ? tags.replace(/,/g, ', ') : '(removed)');
    }
    res.json({ success: true, order: await dbGet(`SELECT * FROM orders WHERE id=?`, [id]) });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── ORDERS: DELETE ──────────────────────────────────────────
app.delete('/api/orders/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const shotRows = await dbAll(`SELECT file_name FROM order_screenshots WHERE order_id=?`, [id]).catch(() => []);
    const gone = await dbRun(`DELETE FROM orders WHERE id=?`, [id]);
    if (gone.changes) await logActivity(id, req.user, 'deleted');
    storage.remove(shotRows.map(r => r.file_name)).catch(e => console.warn('[storage] cleanup:', e.message));
    await dbRun(`DELETE FROM order_screenshots WHERE order_id=?`, [id])
      .catch(e => console.warn(`[orders/delete] #${id} screenshot rows:`, e.message));
    if (Number.isInteger(id) && id > 0) fs.rm(path.join(SS_ROOT, 'orders', String(id)), { recursive: true, force: true },
      e => { if (e) console.warn(`[orders/delete] #${id} screenshot files:`, e.message); });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── SETTINGS: GET ───────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    const rows = await dbAll(`SELECT key, value FROM settings`);
    const settings = {};
    // Staff only receive what their screens display (logo + store name), never other admin settings.
    const STAFF_KEYS = ['macrm_logo', 'macrm_store_name', 'macrm_report_logo'];
    rows.forEach(r => { if (rbac.isAdmin(req.user) || STAFF_KEYS.includes(r.key)) settings[r.key] = r.value; });
    res.json({ success: true, settings });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── SETTINGS: SET ───────────────────────────────────────────
app.post('/api/settings/set', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.json({ success: false, message: 'key required hai' });
    await dbRun(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value=excluded.value`, [key, value||'']);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════════════════════
//  📊 REPORT API — Monthly Report Module
// ════════════════════════════════════════════════════════════

// ── REPORT: GET MONTHLY DATA ────────────────────────────────
// Usage: GET /api/report/2026/5
// month: 1–12 (integer), year: 2025, 2026 etc.
app.get('/api/report/:year/:month', async (req, res) => {
  try {
    const year  = parseInt(req.params.year);
    const month = parseInt(req.params.month); // 1–12 (from report page)
    // NOTE: Existing orders in DB were saved with JS getMonth() which is 0-based
    // So May (month=5) was saved as 4 in DB. We query month-1 to match.
    const dbMonth = month - 1; // 0-based to match existing data

    // ── Summary stats ───────────────────────────────────────
    const summary = await dbGet(`
      SELECT
        COUNT(*)                                                        AS "totalOrders",
        COUNT(DISTINCT name || phone)                                   AS "totalClients",
        SUM(CASE WHEN status IN ('Delivered','delivered') THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status IN ('Cancelled','cancelled') THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN status IN ('Processing','processing','Paid') THEN 1 ELSE 0 END) AS processing,
        COALESCE(SUM(amount), 0)                                        AS "totalRevenue",
        COALESCE(SUM(advance), 0)                                       AS received,
        COALESCE(SUM(amount) - SUM(advance), 0)                        AS pending
      FROM orders
      WHERE month = ? AND year = ?
    `, [dbMonth, year]);

    // ── All orders for this month ───────────────────────────
    const orders = await dbAll(`
      SELECT
        o.id,
        o.name        AS "clientName",
        o.phone,
        o.detail      AS product,
        o.status,
        o.amount,
        o.advance     AS paid,
        (o.amount - o.advance) AS remaining,
        o.tracking_id,
        o.date,
        u.name        AS "assignedTo"
      FROM orders o
      LEFT JOIN users u ON o.assigned_to = u.id
      WHERE o.month = ? AND o.year = ?
      ORDER BY o.id ASC
    `, [dbMonth, year]);

    // ── Per-client aggregation ──────────────────────────────
    const clients = await dbAll(`
      SELECT
        name                     AS "clientName",
        phone,
        COUNT(*)                 AS "totalOrders",
        COALESCE(SUM(amount), 0) AS "totalSpend",
        COALESCE(SUM(advance), 0) AS "totalPaid",
        COALESCE(SUM(amount) - SUM(advance), 0) AS "totalPending"
      FROM orders
      WHERE month = ? AND year = ?
      GROUP BY name, phone
      ORDER BY "totalSpend" DESC
    `, [dbMonth, year]);

    res.json({
      success: true,
      year, month,
      summary,
      orders,
      clients
    });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── REPORT: ALL MONTHS LIST (for dropdown) ──────────────────
app.get('/api/report/months', async (req, res) => {
  try {
    const months = await dbAll(`
      SELECT DISTINCT month, year, COUNT(*) as "orderCount"
      FROM orders
      GROUP BY year, month
      ORDER BY year DESC, month DESC
    `);
    res.json({ success: true, months });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════════════════════
//  👥 STAFF ORDERS — Admin-only reporting (gate: OWNER_ONLY + rbac)
//  GET /api/staff-orders?from=YYYY-MM-DD&to=YYYY-MM-DD&staff_id=N&status=pending|paid|returned|completed|cancelled
//  Every number is calculated from the orders table on each request.
//  "Handled by" = the staff member who placed the order (created_by); for orders placed
//  by the Admin (or before this update) = the staff member it is assigned to.
// ════════════════════════════════════════════════════════════
const BUCKETS = ['pending', 'paid', 'returned', 'completed', 'cancelled'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
app.get('/api/staff-orders', async (req, res) => {
  try {
    if (!rbac.isAdmin(req.user)) return forbid(res, 'Owner access only');
    const q = req.query || {};
    const from = ISO_DAY.test(q.from || '') ? q.from : null;
    const to   = ISO_DAY.test(q.to || '') ? q.to : null;
    const staffFilter  = /^\d+$/.test(String(q.staff_id || '')) ? Number(q.staff_id) : null;
    const statusFilter = BUCKETS.includes(q.status) ? q.status : null;

    const users = await dbAll(`SELECT id, name, email, role, photo FROM users ORDER BY id ASC`);
    const byId = new Map(users.map(u => [u.id, u]));
    const staffIds = new Set(users.filter(u => u.role === 'staff').map(u => u.id));
    const rows = await dbAll(`SELECT id, name, phone, detail, status, amount, advance, tags, date, month, year, placed_date, created_at,
                                     assigned_to, created_by, created_by_role, updated_by, updated_at
                                FROM orders ORDER BY id DESC`);

    const handlerOf = o => {
      if (o.created_by != null && (o.created_by_role === 'staff' || staffIds.has(o.created_by))) return { id: o.created_by, via: 'created' };
      if (o.created_by_role !== 'staff' && o.assigned_to != null && staffIds.has(o.assigned_to)) return { id: o.assigned_to, via: 'assigned' };
      return null;
    };
    const dayOf = o => (ISO_DAY.test(o.placed_date || '') ? o.placed_date : (o.created_at ? String(o.created_at).slice(0, 10) : ''));
    const inRange = d => (!from || (d && d >= from)) && (!to || (d && d <= to));
    const nameOf = id => (byId.get(id) ? byId.get(id).name : `Deleted staff #${id}`);
    const blank = () => ({ total: 0, pending: 0, paid: 0, returned: 0, completed: 0, cancelled: 0, amount: 0, received: 0 });
    const add = (acc, o, bucket) => {
      acc.total++; acc[bucket]++; acc.amount += Number(o.amount) || 0;
      acc.received += bucket === 'paid' ? (Number(o.amount) || 0) : (Number(o.advance) || 0);
    };

    const summary = blank();
    const perStaff = new Map([...staffIds].map(id => [id, blank()]));
    const list = [];
    for (const o of rows) {
      const h = handlerOf(o);
      if (!h) continue;
      const day = dayOf(o);
      if (!inRange(day)) continue;
      const bucket = rbac.statusBucket(o.status);
      add(summary, o, bucket);
      if (!perStaff.has(h.id)) perStaff.set(h.id, blank());
      add(perStaff.get(h.id), o, bucket);
      if ((staffFilter === null || h.id === staffFilter) && (statusFilter === null || bucket === statusFilter)) {
        const amount = Number(o.amount) || 0, advance = Number(o.advance) || 0;
        list.push({
          id: o.id,
          order_code: `MA-${String((Number(o.month) || 0) + 1).padStart(2, '0')}${String(o.year || '').slice(-2)}-${o.id}`,
          customer: o.name, phone: o.phone, detail: o.detail || '',
          date: o.date || day, day,
          status: o.status, bucket,
          payment_status: rbac.paymentStatus(o),
          return_status: bucket === 'returned' ? 'Returned' : '—',
          tags: tagsOf(o), amount, advance, remaining: Math.max(0, amount - advance),
          handled_by: { id: h.id, name: nameOf(h.id), via: h.via, deleted: !byId.has(h.id) },
          updated_by: o.updated_by != null ? { id: o.updated_by, name: byId.get(o.updated_by) ? byId.get(o.updated_by).name : `User #${o.updated_by}` } : null,
          updated_at: o.updated_at || null,
        });
      }
    }

    const staff = [...perStaff.entries()].map(([id, s]) => {
      const u = byId.get(id);
      return { id, name: u ? u.name : `Deleted staff #${id}`, email: u ? u.email : '', photo: u ? u.photo : null, deleted: !u, ...s };
    }).sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));

    // Recent staff activity (who created / edited / changed status / tags), newest first
    let act = await dbAll(`SELECT id, order_id, user_id, user_name, action, detail, created_at FROM order_activity
                            WHERE user_role='staff' ORDER BY id DESC LIMIT 400`).catch(() => []);
    act = act.filter(a => (staffFilter === null || a.user_id === staffFilter) && inRange(String(a.created_at || '').slice(0, 10))).slice(0, 60);

    const LIMIT = 500;
    res.json({ success: true, filters: { from, to, staff_id: staffFilter, status: statusFilter },
      summary, staff, orders: list.slice(0, LIMIT), orders_total: list.length, truncated: list.length > LIMIT, activity: act });
  } catch (e) {
    console.error('[staff-orders]', e.message);
    res.json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════════════════════
//  🤖 AI SCREENSHOT IMPORT → PLACE ORDER
//  Flow: screenshot → Gemini → validated JSON → review screen
//        → human confirms → /api/clients/save → database
//  /api/ai/extract NEVER writes to the database.
// ════════════════════════════════════════════════════════════

// Rate limit + one extraction at a time per browser (protects the API key's quota)
const aiHits = new Map();
const aiInFlight = new Set();
const AI_WINDOW_MS = 10 * 60 * 1000, AI_MAX_PER_WINDOW = 30;
function aiRateOk(ip) {
  const now = Date.now();
  const hits = (aiHits.get(ip) || []).filter(t => now - t < AI_WINDOW_MS);
  if (hits.length >= AI_MAX_PER_WINDOW) { aiHits.set(ip, hits); return false; }
  hits.push(now); aiHits.set(ip, hits);
  return true;
}

const AI_USER_MESSAGES = {
  config:       'AI import is not set up correctly on the server.',
  timeout:      'Gemini took too long to answer.',
  rate_limited: 'Gemini usage limit reached — wait a minute and retry.',
  blocked:      'Gemini refused to read this screenshot.',
  invalid_json: 'Gemini answered, but the answer could not be read.',
  empty:        'Gemini sent an empty answer.',
  bad_request:  'Gemini rejected the request.',
  network:      'The server could not connect to Gemini — check the internet connection, firewall or antivirus.',
  upstream:     'Gemini had a problem answering.',
  bad_image:    'This file could not be used as a screenshot.',
};

// ── AI: STATUS (is the feature configured?) ─────────────────
app.get('/api/ai/status', (req, res) => {
  res.json({
    success: true,
    enabled: AI_ENABLED,
    model: GEMINI_API_KEY ? GEMINI_MODEL : (NVIDIA_API_KEY ? NVIDIA_MODEL : null),
    backups: { geminiKeys: Math.max(0, GEMINI_KEYS.length - 1), nvidia: NVIDIA_API_KEY ? NVIDIA_MODEL : null },
    maxImages: ai.LIMITS.MAX_IMAGES,
    reason: AI_ENABLED ? null : (envInfo.file || envInfo.fromEnvVar ? (keyCheck.problem || 'empty') : 'no_env_file'),
    health: aiHealth,
  });
});

// ── Gemini busy (HTTP 500/502/503/504, "high demand") → retry automatically ──
// A 503 means Google's servers were overloaded; the screenshot never got read.
// Retry the same model with a short wait, then try any backup models.
const AI_RETRY_WAITS_MS = [2000, 5000, 10000];
function aiIsTransient(e) {
  if (!e) return false;
  if (e.code === 'config' || e.code === 'bad_request' || e.code === 'blocked' || e.code === 'bad_image') return false;
  const text = `${e.message || ''} ${e.detail || ''}`;
  return /\b(500|502|503|504)\b|UNAVAILABLE|overloaded|high demand|try again later|INTERNAL|DEADLINE_EXCEEDED/i.test(text)
    || e.code === 'timeout' || e.code === 'network';
}
// Sleeps ms — but wakes up immediately if the browser disconnects, instead of
// finishing the whole wait in the background after the user has given up.
const aiSleep = (ms, signal) => new Promise(r => {
  const t = setTimeout(r, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});
// HTTP 429 / RESOURCE_EXHAUSTED = this model's quota for the API key is used up.
// Retrying the same model is pointless, but each model has its OWN quota → try the backups.
function aiIsQuota(e) {
  return !!e && (e.code === 'rate_limited' || /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(`${e.message || ''} ${e.detail || ''}`));
}
// Providers are tried in this order: every Gemini key (main model, then backup models),
// then NVIDIA. A provider that just failed is skipped for a while (cool-down) so the NEXT
// screenshots go straight to a working one instead of waiting through the same errors again.
// Each screenshot is handled on its own: the ones already read are never redone.
const aiCooldown = new Map();               // provider id → timestamp until which it is skipped
const AI_COOLDOWN_QUOTA_MS = 120000;        // 429
const AI_COOLDOWN_BUSY_MS  = 30000;         // 503 etc.
const AI_COOLDOWN_KEY_MS   = 600000;        // bad key / model missing
function aiBuildChain() {
  const chain = [];
  GEMINI_KEYS.forEach((key, ki) => {
    [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS].forEach(model =>
      chain.push({ id: `gemini${ki}:${model}`, kind: 'gemini', key, model, label: `Gemini key ${ki + 1} / ${model}` }));
  });
  if (NVIDIA_API_KEY) chain.push({ id: `nvidia:${NVIDIA_MODEL}`, kind: 'nvidia', model: NVIDIA_MODEL, label: `NVIDIA / ${NVIDIA_MODEL}` });
  return chain;
}
async function aiCallGeminiWithRetry(opts, log, signal) {
  const chain = aiBuildChain();
  if (!chain.length) throw new ai.AiError('config', AI_USER_MESSAGES.config);
  const now = Date.now();
  let usable = chain.filter(c => (aiCooldown.get(c.id) || 0) <= now);
  if (!usable.length) usable = chain;           // everything cooling down → just try them all again
  const hasBackup = chain.length > 1;
  const tried = [];
  const errs = [];
  for (const [n, entry] of usable.entries()) {
    if (signal && signal.aborted) throw new ai.AiError('aborted', 'Request was cancelled by the browser');
    // First provider: patient retries if it is the only one, one quick retry if backups exist.
    const waits = n === 0 ? (hasBackup ? [2000] : AI_RETRY_WAITS_MS) : [];
    for (let attempt = 0; attempt <= waits.length; attempt++) {
      try {
        const out = entry.kind === 'gemini'
          ? await ai.callGemini({ ...opts, apiKey: entry.key, model: entry.model, signal })
          : await ai.callNvidia({ apiKey: NVIDIA_API_KEY, model: entry.model, baseUrl: NVIDIA_BASE_URL, image: opts.image, index: opts.index, total: opts.total, signal });
        if (n > 0 || attempt) log(`succeeded on ${entry.label} (attempt ${attempt + 1})`);
        aiCooldown.delete(entry.id);
        return { ...out, provider: entry.label };
      } catch (e) {
        if (e.code === 'aborted' || e.code === 'bad_image' || e.code === 'blocked') throw e;   // not a provider problem
        errs.push(e);
        if (aiIsQuota(e)) {
          aiCooldown.set(entry.id, Date.now() + AI_COOLDOWN_QUOTA_MS);
          tried.push(`${entry.label}: quota (429)`);
          log(`${entry.label} quota used up (429) — switching to the next provider`);
          break;
        }
        if (!aiIsTransient(e)) {
          aiCooldown.set(entry.id, Date.now() + (e.code === 'config' ? AI_COOLDOWN_KEY_MS : AI_COOLDOWN_BUSY_MS));
          tried.push(`${entry.label}: not usable (${e.code || 'error'})`);
          log(`${entry.label} failed: ${e.message} — switching to the next provider`);
          break;
        }
        if (attempt < waits.length) {
          log(`${entry.label} busy (${e.message}) — retrying in ${waits[attempt] / 1000}s`);
          await aiSleep(waits[attempt], signal);
        } else {
          aiCooldown.set(entry.id, Date.now() + AI_COOLDOWN_BUSY_MS);
          tried.push(`${entry.label}: busy`);
          log(`${entry.label} busy — switching to the next provider`);
        }
      }
    }
  }
  if (signal && signal.aborted) throw new ai.AiError('aborted', 'Request was cancelled by the browser');
  const lastErr = errs.find(aiIsQuota) || errs.find(aiIsTransient) || errs[errs.length - 1] || new ai.AiError('upstream', 'No AI provider could read this screenshot');
  const names = chain.length > 1 ? `sab ${chain.length} options (Gemini + backup)` : 'Gemini';
  if (aiIsQuota(lastErr)) {
    lastErr.code = 'rate_limited';
    lastErr.message = `AI ki quota khatam ho gayi hai (HTTP 429) — ${names} try kiye. Code ki ghalti nahi: provider ne limit band kar di hai.`;
  } else if (aiIsTransient(lastErr)) {
    lastErr.message = `AI abhi bohat busy hai — ${names} try kiye. Screenshot ki koi ghalti nahi. 1–2 minute baad Retry karein.`;
  }
  lastErr.detail = `[server v4] Tried → ${tried.join(' | ')}. ${lastErr.detail || ''}`.slice(0, 500);
  throw lastErr;
}

// Runs fn over items with at most `limit` at once (keeps 5 screenshots from hitting the API in one burst)
async function aiMapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Only these details are taken from a parcel screenshot (PostEx etc.):
// name, phone number(s), address, tracking ID, price (COD amount).
// Product + quantity: kept if the extractor returns them (order.lines / order.items);
// otherwise the review form uses the CRM default ("Safoof").
// Everything else the model returns (email, notes, ...) is dropped here.
const AI_CLIENT_FIELDS = ['name', 'phones', 'phone_unreadable', 'address'];
const AI_ORDER_FIELDS  = ['tracking_id', 'cod_amount', 'lines', 'items'];
function aiKeepOrderFieldsOnly(draft) {
  if (!draft || typeof draft !== 'object') return draft;
  const pick = (obj, keys) => {
    const out = {};
    if (obj && typeof obj === 'object') keys.forEach(k => { if (k in obj) out[k] = obj[k]; });
    return out;
  };
  draft.client = pick(draft.client, AI_CLIENT_FIELDS);
  draft.order  = pick(draft.order, AI_ORDER_FIELDS);
  const allowed = new Set([...AI_CLIENT_FIELDS, ...AI_ORDER_FIELDS, 'phone']);
  if (Array.isArray(draft.warnings)) {
    draft.warnings = draft.warnings.filter(w => !w || !w.field || allowed.has(w.field));
  }
  const has = f => f && f.value !== null && f.value !== undefined && f.value !== '';
  const filled = (has(draft.client.name) ? 1 : 0)
    + (has(draft.client.address) ? 1 : 0)
    + (Array.isArray(draft.client.phones) ? draft.client.phones.length : 0)
    + (has(draft.order.tracking_id) ? 1 : 0)
    + (has(draft.order.cod_amount) ? 1 : 0)
    + (Array.isArray(draft.order.lines) ? draft.order.lines.length : (Array.isArray(draft.order.items) ? draft.order.items.length : 0));
  draft.stats = Object.assign({}, draft.stats, { filled });
  return draft;
}

// ── AI: EXTRACT (returns a draft for review — saves nothing) ──
app.post('/api/ai/extract', async (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'local';
  if (!AI_ENABLED) return res.json({ success: false, code: 'config', message: AI_USER_MESSAGES.config });
  if (aiInFlight.has(ip)) return res.json({ success: false, code: 'busy', message: 'An extraction is already running. Wait for it to finish.' });
  if (!aiRateOk(ip)) return res.json({ success: false, code: 'rate_limited', message: 'Too many extractions in a short time. Wait a few minutes.' });

  aiInFlight.add(ip);
  // If the browser disconnects (modal closed, fetch aborted, tab closed), stop
  // retrying Gemini right away instead of finishing the whole chain in the
  // background and holding this IP's lock for no one.
  const reqCtrl = new AbortController();
  // IMPORTANT: this must be res.on('close'), not req.on('close'). req's 'close'
  // fires as soon as Express finishes reading the request body (i.e. almost
  // immediately, long before any response is sent) — it does NOT mean the
  // browser disconnected. res's 'close' fires when the underlying connection
  // actually goes away, which is what we want to react to.
  res.on('close', () => { if (!res.writableEnded) reqCtrl.abort(); });
  const started = Date.now();
  try {
    const imagesIn = Array.isArray(req.body && req.body.images) ? req.body.images : [];
    if (!imagesIn.length) return res.json({ success: false, code: 'bad_image', message: 'Upload at least one screenshot.' });
    if (imagesIn.length > ai.LIMITS.MAX_IMAGES) return res.json({ success: false, code: 'bad_image', message: `Maximum ${ai.LIMITS.MAX_IMAGES} screenshots per import.` });

    let images;
    try { images = imagesIn.map((img, i) => ai.decodeImage(img, i + 1)); }
    catch (e) {
      console.warn('[AI import] bad image:', e.message);
      return res.json({ success: false, code: 'bad_image', message: e.message });
    }

    const total = images.length;
    const results = await aiMapLimit(images, 2, async (image, i) => {
      const tag = `[AI import] screenshot ${i + 1}/${total} (model ${GEMINI_MODEL}, ${image.mime}, ${Math.max(1, Math.round(image.bytes / 1024))} KB)`;
      try {
        const out = await aiCallGeminiWithRetry({
          apiKey: GEMINI_API_KEY, model: GEMINI_MODEL, image, index: i + 1, total,
          onLog: msg => console.warn(`${tag} ${msg}`),
        }, msg => console.warn(`${tag} ${msg}`), reqCtrl.signal);
        const data = ai.validateParcel(out.data);
        console.log(`${tag} OK via ${out.provider || 'Gemini'} ("${out.variant}" request)`);
        return { index: i + 1, ok: true, data };
      } catch (e) {
        const code = e.code || 'upstream';
        console.warn(`${tag} FAILED — ${code}: ${e.message}${e.detail ? ' | ' + e.detail : ''}`);
        if (code === 'config') aiHealth = { state: 'key_rejected', message: e.message };
        return { index: i + 1, ok: false, code, error: e.message, detail: e.detail || null };
      }
    });

    if (reqCtrl.signal.aborted || res.writableEnded) {
      console.log(`[AI import] browser disconnected after ${((Date.now() - started) / 1000).toFixed(1)}s — stopped early, lock released`);
      return;
    }

    const draft = aiKeepOrderFieldsOnly(ai.mergeParcels(results));
    console.log(`[AI import] done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${draft.stats.used}/${total} screenshots read, ${draft.stats.filled} fields filled`);

    // Even one readable field is a success: the review form opens with it.
    if (draft.stats.filled > 0) return res.json({ success: true, draft });

    const failed = results.find(r => !r.ok);
    if (failed) {
      return res.json({
        success: false, code: failed.code,
        message: failed.code === 'network' ? AI_USER_MESSAGES.network : failed.error,
        detail: failed.detail,
      });
    }
    return res.json({ success: false, code: 'nothing_found', message: 'No name, phone number, tracking ID or price could be read from this screenshot.' });
  } catch (e) {
    console.error('[AI import] unexpected error:', e && e.stack || e);
    res.json({ success: false, code: 'upstream', message: 'Unexpected server error while reading the screenshot.', detail: String(e && e.message || e).slice(0, 200) });
  } finally {
    aiInFlight.delete(ip);
  }
});

// ════════════════════════════════════════════════════════════
//  📎 ORIGINAL SCREENSHOTS
//  Uploaded the moment the user adds a screenshot, stored exactly as
//  received (no resize / re-encode). Upload sends NOTHING to WhatsApp.
// ════════════════════════════════════════════════════════════
const SS_ID_RE = /^[a-f0-9]{32}\.(png|jpg|webp)$/;
const SS_MAX_BYTES = 20 * 1024 * 1024;
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return { mime: 'image/png', ext: 'png' };
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

app.post('/api/screenshots/temp', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  try {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.json({ success: false, code: 'bad_image', message: 'Screenshot file khali hai' });
    if (buf.length > SS_MAX_BYTES) return res.json({ success: false, code: 'too_large', message: 'Screenshot 20 MB se bara hai' });
    const kind = sniffImage(buf);
    if (!kind) return res.json({ success: false, code: 'bad_image', message: 'Sirf PNG, JPG ya WEBP screenshot chalte hain' });
    let name = '';
    try { name = decodeURIComponent(req.get('X-File-Name') || ''); }
    catch (e) { console.warn('[screenshots/temp] file name not decodable, saving without name'); }
    name = name.replace(/[\\/\x00-\x1f"]/g, '').slice(0, 120);
    const id = crypto.randomBytes(16).toString('hex') + '.' + kind.ext;
    const meta = { name, mime: kind.mime, bytes: buf.length, sha256: sha256(buf), uploaded_at: new Date().toISOString() };
    await fs.promises.writeFile(path.join(SS_TMP, id), buf, { flag: 'wx' });
    await fs.promises.writeFile(path.join(SS_TMP, id + '.json'), JSON.stringify(meta));
    res.json({ success: true, id, sha256: meta.sha256, bytes: meta.bytes, mime: meta.mime });
  } catch (e) {
    console.error('[screenshots/temp]', e.message);
    res.json({ success: false, code: 'upload_failed', message: 'Screenshot server par save nahi hua: ' + e.message });
  }
});

app.get('/api/orders/:id/screenshots', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rows = await dbAll(`SELECT id, position, original_name, mime, bytes FROM order_screenshots WHERE order_id=? ORDER BY position ASC`, [id]);
    res.json({ success: true, screenshots: rows.map(r => ({ ...r, url: `/api/orders/${id}/screenshots/${r.id}/file` })) });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

app.get('/api/orders/:id/screenshots/:sid/file', async (req, res) => {
  try {
    const row = await dbGet(`SELECT file_name, mime FROM order_screenshots WHERE id=? AND order_id=?`, [parseInt(req.params.sid), parseInt(req.params.id)]);
    if (!row) return res.status(404).json({ success: false, message: 'Screenshot nahi mila' });
    if (!(await storage.ensureLocal(SS_ROOT, row.file_name))) return res.status(404).json({ success: false, message: 'Screenshot file nahi mili' });
    res.type(row.mime).sendFile(path.join(SS_ROOT, row.file_name));
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Unplaced uploads older than 24h are removed (placed orders keep theirs forever)
async function cleanScreenshotTmp() {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of await fs.promises.readdir(SS_TMP)) {
      const full = path.join(SS_TMP, f);
      const st = await fs.promises.stat(full).catch(() => null);
      if (st && st.isFile() && st.mtimeMs < cutoff) await fs.promises.unlink(full).catch(e => console.warn('[screenshots] tmp cleanup:', e.message));
    }
  } catch (e) { console.warn('[screenshots] tmp cleanup failed:', e.message); }
}

// ════════════════════════════════════════════════════════════
//  📅 ORDER PLACED DATE  +  📦 VPL 3-DAY WHATSAPP REMINDER
//  Separate from the order / WhatsApp-confirmation code: it only reads and writes
//  the new columns above and sends through waSender.sendText().
// ════════════════════════════════════════════════════════════
const localISODate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isVplTracking = t => /^VPL/i.test(String(t || '').trim());
// whole calendar days from `fromISO` to `toISO` (date only, no time-of-day / DST effects)
function daysBetween(fromISO, toISO) {
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  const a = re.exec(fromISO || ''), b = re.exec(toISO || '');
  if (!a || !b) return null;
  return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 86400000);
}

// Called after an order's tracking ID is saved. A NEW VPL tracking ID = parcel shipped today.
// Same ID saved again (e.g. editing the status) never changes the date.
async function recordShipment(orderId, prevTracking, newTracking) {
  if (!isVplTracking(newTracking)) return;
  if (String(prevTracking || '').trim().toUpperCase() === String(newTracking).trim().toUpperCase()) return;
  await dbRun(`UPDATE orders SET shipped_date=?, vpl_reminder_sent=0, vpl_reminder_sent_at=NULL, vpl_reminder_error=NULL WHERE id=?`,
    [localISODate(), orderId]);
}

const VPL_REMINDER_TEXT = 'Assalam o Alaikum, aap ka parcel post office mein aa gaya hai. Barah-e-karam apne qareebi dak khane se apna parcel receive kar lein. Shukriya.';
// Parcel already with the customer / cancelled → "parcel post office mein aa gaya" would be wrong.
const VPL_SKIP_STATUSES = ['Delivered', 'Paid', 'Return', 'Cancelled'];
const VPL_RETRY_MS = 5 * 60 * 1000;

function vplNumber(o) {
  if (o.wa_phone) { const n = phoneUtil.normalize(o.wa_phone); if (n.ok) return n.number; }
  const p = phoneUtil.pickWhatsApp(phoneUtil.split(o.phone || ''));
  return p.ok ? p.number : null;
}

// Orders that qualify TODAY: VPL tracking + shipped date + EXACTLY 3 days + reminder not sent yet.
async function findVplDue(today = localISODate()) {
  const rows = await dbAll(
    `SELECT id, name, phone, wa_phone, status, tracking_id, shipped_date FROM orders
      WHERE shipped_date IS NOT NULL AND shipped_date <> ''
        AND COALESCE(vpl_reminder_sent, 0) = 0
        AND vpl_reminder_error IS NULL
        AND UPPER(TRIM(tracking_id)) LIKE 'VPL%'`);
  return rows.filter(o => daysBetween(o.shipped_date, today) === 3 && !VPL_SKIP_STATUSES.includes(o.status));
}

let vplRunning = false, vplWaitLogged = false;
async function runVplReminders(trigger) {
  if (vplRunning) return;
  vplRunning = true;
  try {
    const due = await findVplDue();
    if (!due.length) { if (trigger === 'startup') console.log('📦 VPL reminders: aaj koi parcel exactly 3 din ka nahi'); return; }
    if (waSender.status().state !== 'ready') {
      if (!vplWaitLogged) console.log(`📦 VPL reminders: ${due.length} parcel due hain, WhatsApp Web tab ready nahi — ${VPL_RETRY_MS / 60000} minute baad dobara check hoga`);
      vplWaitLogged = true;
      return;
    }
    vplWaitLogged = false;
    console.log(`📦 VPL reminders: ${due.length} parcel(s) ko 3-day reminder bhej raha hoon`);
    for (const o of due) {
      const fresh = await dbGet(`SELECT vpl_reminder_sent FROM orders WHERE id=?`, [o.id]);
      if (!fresh || fresh.vpl_reminder_sent) continue;            // duplicate protection
      const number = vplNumber(o);
      if (!number) { console.warn(`📦 VPL reminder #${o.id}: WhatsApp number sahi nahi — skip`); continue; }
      try {
        await waSender.sendText(number, VPL_REMINDER_TEXT);
        for (let attempt = 1; attempt <= 2; attempt++) {           // sent → mark YES right away
          try { await dbRun(`UPDATE orders SET vpl_reminder_sent=1, vpl_reminder_sent_at=CURRENT_TIMESTAMP WHERE id=?`, [o.id]); break; }
          catch (e) { console.error(`📦 VPL reminder #${o.id}: sent flag save fail (try ${attempt}):`, e.message); }
        }
        console.log(`📦 VPL reminder bhej diya → order #${o.id}`);
      } catch (e) {
        if (e.step === 'send') {   // outcome unknown — never risk a second message
          await dbRun(`UPDATE orders SET vpl_reminder_error=? WHERE id=?`, ['UNCERTAIN: ' + String(e.message).slice(0, 200), o.id]).catch(() => {});
          console.warn(`📦 VPL reminder #${o.id}: send step ka nateeja maloom nahi — dobara nahi bheja jayega, chat check karein`);
        } else {
          console.warn(`📦 VPL reminder #${o.id} fail (${e.code || 'error'}): ${e.message} — agli baar dobara koshish`);
          if (['no_extension', 'no_tab', 'not_linked'].includes(e.code)) break;
        }
      }
    }
  } catch (e) {
    console.error('📦 VPL reminders error:', e.message);
  } finally {
    vplRunning = false;
  }
}

// What would be sent today (read-only, sends nothing) — handy for checking.
app.get('/api/vpl-reminders/due', async (req, res) => {
  try {
    const due = await findVplDue();
    res.json({ success: true, today: localISODate(), count: due.length,
      orders: due.map(o => ({ id: o.id, name: o.name, shipped_date: o.shipped_date, whatsapp_ok: !!vplNumber(o) })) });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  🛒 PLACE ORDER — one path for BOTH ways of creating an order
//     AI import  → /api/clients/save  ┐
//     Manual form → /api/orders/add   ┴→ checkWhatsAppOrder() → placeOrder()
//  placeOrder: save order + original screenshots → confirm saved →
//  THEN processWhatsAppForOrder(). WhatsApp never looks at the source.
// ════════════════════════════════════════════════════════════
function cleanLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map(l => ({ product: String((l && l.product) || '').trim().slice(0, 100), qty: Number(l && l.qty) }))
    .filter(l => l.product && Number.isInteger(l.qty) && l.qty >= 1 && l.qty <= 9999);
}
const saveFail = (res, message, extra) => res.json({ success: false, code: 'validation', message, ...extra });
const cleanAddress = a => String(a || '').replace(/\s+/g, ' ').trim().slice(0, 300);

// Validation shared by AI + manual: original screenshot(s), WhatsApp-ready number, product + quantity.
async function checkWhatsAppOrder({ waIn, phones, lines }) {
  const ids = Array.isArray(waIn.screenshot_ids) ? waIn.screenshot_ids : [];
  if (!ids.length) return { ok: false, message: 'Original order screenshot zaroori hai — screenshot upload karein' };
  if (ids.length > 10 || new Set(ids).size !== ids.length) return { ok: false, message: 'Screenshots ki list sahi nahi' };
  const shots = [];
  for (const sid of ids) {
    if (typeof sid !== 'string' || !SS_ID_RE.test(sid)) return { ok: false, message: 'Screenshot reference sahi nahi' };
    const file = path.join(SS_TMP, sid);
    try {
      const meta = JSON.parse(await fs.promises.readFile(file + '.json', 'utf8'));
      await fs.promises.access(file);
      shots.push({ sid, file, meta });
    } catch (e) {
      console.warn(`[place order] screenshot ${sid} missing:`, e.message);
      return { ok: false, message: 'Original screenshot server par nahi mila (24 ghante se purana?) — dobara upload karein' };
    }
  }
  let wa = waIn.phone ? phoneUtil.normalize(waIn.phone) : phoneUtil.pickWhatsApp(phones);
  if (wa.ok && waIn.phone && !phones.some(p => phoneUtil.sameNumber(p, waIn.phone))) {
    wa = { ok: false, reason: 'WhatsApp number order ke numbers mein se nahi' };
  }
  if (!wa.ok) return { ok: false, message: 'WhatsApp ke liye sahi mobile number chahiye — ' + wa.reason };
  const cleaned = cleanLines(lines);
  if (!cleaned.length) return { ok: false, message: 'Product aur quantity zaroori hain' };
  return { ok: true, shots, wa, lines: cleaned };
}

// Saves the order. With `whatsapp` (from checkWhatsAppOrder) it also attaches the original
// screenshots, freezes the order data, and — only after all of that is committed — starts WhatsApp.
async function placeOrder(row, { address = '', whatsapp = null } = {}) {
  let orderId = null;
  const moved = [];
  try {
    const r = await dbRun(
      `INSERT INTO orders (name,phone,detail,amount,advance,status,assigned_to,tracking_id,date,month,year,client_id,source,address,workflow_state,wa_phone,tags,created_by,created_by_role)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.name, row.phone, row.detail || '', row.amount, row.advance || 0, row.status || 'Processing', row.assigned_to || 1,
       row.tracking_id || '', row.date, row.month, row.year, null, row.source || 'manual',
       address, whatsapp ? 'ORDER_PLACED' : null, whatsapp ? whatsapp.wa.number : null,
       row.tags || '', row.created_by || null, row.created_by_role || null]);
    orderId = r.lastID;

    // Order Placed Date — stamped by the server at the moment of placement. Failure here never blocks the order.
    try {
      await dbRun(`UPDATE orders SET placed_date=?, shipped_date=? WHERE id=?`,
        [localISODate(), isVplTracking(row.tracking_id) ? localISODate() : null, orderId]);
    } catch (e) { console.warn(`[place order] #${orderId} placed_date save fail:`, e.message); }

    if (whatsapp) {
      const dir = path.join(SS_ROOT, 'orders', String(orderId));
      await fs.promises.mkdir(dir, { recursive: true });
      for (let i = 0; i < whatsapp.shots.length; i++) {
        const { sid, file, meta } = whatsapp.shots[i];
        const dest = path.join(dir, sid);
        await fs.promises.rename(file, dest);          // moved, never copied / re-encoded
        moved.push({ from: file, to: dest });
        const bytes = await fs.promises.readFile(dest);
        if (sha256(bytes) !== meta.sha256) throw new Error(`Screenshot ${i + 1} file kharab hai`);
        // Permanent copy in Supabase Storage. If it fails the whole order is undone (nothing half-saved).
        try { await storage.put(`orders/${orderId}/${sid}`, bytes, meta.mime); }
        catch (se) { throw new Error('Screenshot permanent storage mein save nahi hua: ' + se.message); }
        await dbRun(
          `INSERT INTO order_screenshots (order_id, position, file_name, original_name, mime, bytes, sha256) VALUES (?,?,?,?,?,?,?)`,
          [orderId, i, `orders/${orderId}/${sid}`, meta.name || '', meta.mime, meta.bytes, meta.sha256]);
      }
      const saved = await dbGet(`SELECT * FROM orders WHERE id=?`, [orderId]);
      const snapshot = {
        order_id: orderId,
        order_code: `MA-${String(saved.month + 1).padStart(2, '0')}${String(saved.year).slice(-2)}-${orderId}`,
        source: saved.source,                         // informational only — WhatsApp ignores it
        name: saved.name, phone: saved.phone, wa_phone: whatsapp.wa.number, address,
        lines: whatsapp.lines, detail: saved.detail, amount: Number(saved.amount), advance: Number(saved.advance) || 0,
        tracking_id: saved.tracking_id || '', business: BUSINESS_NAME, saved_at: new Date().toISOString(),
      };
      await dbRun(`UPDATE orders SET wa_snapshot=? WHERE id=?`, [JSON.stringify(snapshot), orderId]);
      whatsapp.shots.forEach(s => fs.promises.unlink(s.file + '.json')
        .catch(e => console.warn('[place order] temp meta cleanup:', e.message)));
    }
  } catch (e) {
    if (orderId) {   // half-saved → undo completely, so nothing is left behind and nothing is sent
      console.error(`[place order] save failed, undoing #${orderId}:`, e.message);
      for (const m of moved.reverse()) await fs.promises.rename(m.to, m.from).catch(x => console.error('[place order] undo move:', x.message));
      await dbRun(`DELETE FROM order_screenshots WHERE order_id=?`, [orderId]).catch(x => console.error('[place order] undo rows:', x.message));
      await dbRun(`DELETE FROM orders WHERE id=?`, [orderId]).catch(x => console.error('[place order] undo order:', x.message));
    }
    throw e;
  }

  // ── ORDER IS SAVED. Nothing below can undo it. ──
  let waStarted = false;
  if (whatsapp) {
    try { waStarted = await waFlow.processWhatsAppForOrder(orderId); }
    catch (e) { console.error(`[WhatsApp] could not start for order #${orderId}:`, e.message); }
  }
  const order = await dbGet(`SELECT o.*, (SELECT COUNT(*) FROM order_screenshots s WHERE s.order_id=o.id) AS screenshot_count
                             FROM orders o WHERE o.id=?`, [orderId]);
  return { order, waStarted };
}

// ── AI IMPORT → PLACE ORDER ──
app.post('/api/clients/save', async (req, res) => {
  try {
    if (!req.body || req.body.mode !== 'client_and_order') return saveFail(res, 'Only Place Order is supported');
    const waIn = (req.body.whatsapp && typeof req.body.whatsapp === 'object') ? req.body.whatsapp : null;
    const forValidator = { ...req.body };
    delete forValidator.whatsapp;
    const v = ai.validateSavePayload(forValidator);
    if (!v.ok) return saveFail(res, v.errors[0], { errors: v.errors });
    const { source, client, order } = v.value;
    if (!order) return saveFail(res, 'Order details required hain');

    let whatsapp = null;
    if (source === 'ai_screenshot' || waIn) {
      const phones = Array.isArray(req.body.client && req.body.client.phones) ? req.body.client.phones.map(String) : phoneUtil.split(client.phone);
      whatsapp = await checkWhatsAppOrder({ waIn: waIn || {}, phones, lines: req.body.order && req.body.order.lines });
      if (!whatsapp.ok) return saveFail(res, whatsapp.message);
    }

    const staffUser = !rbac.isAdmin(req.user);
    if (staffUser && order.status && order.status !== 'Processing' && !rbac.canSetStatus(req.user, order.status))
      return forbid(res, `"${order.status}" status lagane ki permission nahi hai — order Processing mein place karein.`);
    let assignedTo;
    if (staffUser) {
      assignedTo = req.user.id;                             // a staff member's order is always their own
    } else if (order.assigned_to) {
      const u = await dbGet(`SELECT id FROM users WHERE id=?`, [order.assigned_to]);
      if (!u) return saveFail(res, 'Selected staff member was not found');
      assignedTo = u.id;
    } else {
      const admin = await dbGet(`SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1`);
      assignedTo = admin ? admin.id : 1;
    }
    const parts = ai.isoToParts(order.order_date);
    const out = await placeOrder({
      name: client.name, phone: client.phone, detail: order.detail, amount: order.amount, advance: order.advance,
      status: order.status, assigned_to: assignedTo, tracking_id: order.tracking_id,
      date: order.date_label || parts.label, month: parts.month, year: parts.year, source,
      created_by: req.user.id, created_by_role: req.user.role,
    }, { address: cleanAddress(req.body.client && req.body.client.address), whatsapp });
    await logActivity(out.order.id, req.user, 'created', `${out.order.status || 'Processing'} · Rs ${Number(out.order.amount) || 0}${source === 'ai_screenshot' ? ' · AI import' : ''}`);
    res.json({ success: true, order: out.order, whatsapp: { started: out.waStarted } });
  } catch (e) {
    console.error('[clients/save]', e.stack || e.message);
    res.json({ success: false, code: 'save_failed', message: 'Order could not be saved. WhatsApp was not opened.', detail: e.message });
  }
});

// ════════════════════════════════════════════════════════════
//  💬 WHATSAPP — status, retry, session (QR link)
//  None of these can create an order.
// ════════════════════════════════════════════════════════════
app.get('/api/orders/:id/whatsapp', async (req, res) => {
  try {
    const st = await waFlow.getStatus(parseInt(req.params.id));
    if (!st) return res.json({ success: false, code: 'not_found', message: 'Order nahi mila' });
    res.json({ success: true, whatsapp: st });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post('/api/orders/:id/whatsapp/retry', async (req, res) => {
  try {
    const out = await waFlow.retry(parseInt(req.params.id), { standard: !!(req.body && req.body.standard) });
    res.json(out.ok ? { success: true } : { success: false, code: out.code, message: out.message });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post('/api/orders/:id/whatsapp/mark-sent', async (req, res) => {
  try {
    const ok = await waFlow.markSent(parseInt(req.params.id));
    res.json(ok ? { success: true } : { success: false, message: 'Sirf failed WhatsApp ko "sent" mark kar saktay hain' });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

app.get('/api/whatsapp/session', (req, res) => res.json({ success: true, session: waSender.status() }));
app.post('/api/whatsapp/session/start', async (req, res) => {
  try { res.json({ success: true, session: await waSender.start() }); }
  catch (e) { res.json({ success: false, message: e.message }); }
});
// Proves the CRM can drive WhatsApp Web in THIS browser: sends a short text to a number you choose.
app.post('/api/whatsapp/test', async (req, res) => {
  const ph = phoneUtil.normalize(req.body && req.body.phone);
  if (!ph.ok) return res.json({ success: false, code: 'bad_phone', message: ph.reason });
  try { await waSender.sendTest(ph.number); res.json({ success: true, result: { to: ph.display } }); }
  catch (e) {
    console.warn('[WhatsApp] test message failed:', e.code || '', e.message);
    res.json({ success: false, code: e.code || 'error', message: e.message });
  }
});
// ── Bridge for the "MA CRM WhatsApp" browser extension (same browser as the CRM) ──
app.post('/api/wa-bridge/crm-poll', (req, res) => res.json(waSender.crmPoll(req.body || {})));
app.post('/api/wa-bridge/poll', (req, res) => {
  const b = req.body || {};
  res.json({ success: true, job: waSender.poll({ tabId: Number(b.tabId), loggedIn: b.loggedIn, version: String(b.version || '').slice(0, 20) }) });
});
app.post('/api/wa-bridge/jobs/:id/report', async (req, res) => {
  const b = req.body || {};
  try {
    res.json(await waSender.report({ jobId: req.params.id, tabId: Number(b.tabId), step: b.step, state: b.state,
      code: b.code ? String(b.code).slice(0, 40) : null, message: b.message ? String(b.message).slice(0, 300) : null }));
  } catch (e) { console.error('[wa-bridge] report:', e.message); res.json({ ok: false, message: e.message }); }
});
app.get('/api/wa-bridge/jobs/:id/files/:index', (req, res) => {
  const f = waSender.fileFor({ jobId: req.params.id, index: parseInt(req.params.index), tabId: Number(req.query.tabId) });
  if (!f) return res.status(404).json({ success: false, message: 'File not available for this job' });
  res.setHeader('X-File-Name', encodeURIComponent(f.name || 'order-screenshot'));
  res.setHeader('Access-Control-Expose-Headers', 'X-File-Name');
  res.type(f.mime).sendFile(f.path);
});

app.post('/api/whatsapp/session/logout', async (req, res) => {
  try { res.json({ success: true, session: await waSender.logout() }); }
  catch (e) { res.json({ success: false, message: e.message }); }
});

// ── BACKUP (owner only — gate in auth.js) ──────────────────
// Supabase keeps its own backups; SQLite mode writes a consistent copy next to the database.
app.post('/api/backup', async (req, res) => {
  try {
    if (DB.engine === 'postgres')
      return res.json({ success: false, message: 'Database Supabase par hai — backups Supabase dashboard (Database → Backups) mein hotay hain.' });
    const file = `macrm-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });
    await dbRun(`VACUUM INTO '${path.join(DATA_DIR, 'backups', file).replace(/'/g, "''")}'`);
    res.json({ success: true, backup: { file } });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// ── HEALTH CHECK ────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'MA CRM Server chal raha hai ✅', version: '1.5' });
});

// ── BODY ERRORS → JSON (e.g. screenshots too large) ─────────
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ success: false, code: 'too_large', message: 'Upload too large. Use smaller or fewer screenshots.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ success: false, code: 'bad_request', message: 'Invalid request data.' });
  next(err);
});

// ── CATCH ALL → index.html ──────────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ error: 'index.html nahi mila. public/ folder mein rakho.' });
  }
});

// ── AI SETUP DIAGNOSTICS (printed at start) ─────────────────
function logAiSetup() {
  const nodeMajor = parseInt(process.versions.node, 10);
  console.log('──── 🤖 AI Screenshot Import ────');
  console.log(`   Node.js: v${process.versions.node}${nodeMajor < 18 ? '  ⚠ Node 18+ chahiye (nodejs.org se LTS install karein)' : ''}`);
  console.log(`   Settings file: ${envInfo.file ? envInfo.file + '  (' + path.join(__dirname, envInfo.file) + ')' : 'NAHI MILI'}`);
  envInfo.notes.forEach(n => console.log('   ⚠ ' + n));
  if (!AI_ENABLED) {
    if (!envInfo.file && !envInfo.fromEnvVar) {
      console.log(`   ❌ OFF — is folder mein ".env" file banayein: ${__dirname}`);
      console.log('      Us mein ek line likhein:  GEMINI_API_KEY=aap_ki_key');
    } else if (keyCheck.problem === 'placeholder') {
      console.log('   ❌ OFF — GEMINI_API_KEY mein abhi placeholder likha hai, asli key paste karein');
    } else {
      console.log('   ❌ OFF — GEMINI_API_KEY khali hai. "GEMINI_API_KEY=" ke baad key paste karein');
    }
    console.log('');
    return;
  }
  console.log(`   Key: ${ai.maskKey(GEMINI_API_KEY)}${envInfo.fromEnvVar ? '  (Windows/system environment variable se)' : ''}`);
  console.log(`   Model: ${GEMINI_MODEL}${GEMINI_FALLBACK_MODELS.length ? ' (backup: ' + GEMINI_FALLBACK_MODELS.join(', ') + ')' : ''}`);
  console.log(`   Backup: ${GEMINI_KEYS.length > 1 ? (GEMINI_KEYS.length - 1) + ' extra Gemini key(s)' : 'koi extra Gemini key nahi'}${NVIDIA_API_KEY ? ' + NVIDIA ' + NVIDIA_MODEL : ' (NVIDIA_API_KEY set nahi)'}`);
  if (!GEMINI_API_KEY) { console.log('   ⚠ Main GEMINI_API_KEY nahi hai — sirf backup providers chalenge'); console.log(''); return; }
  console.log('   Key check ho rahi hai...');
  ai.verifyGeminiKey({ apiKey: GEMINI_API_KEY, model: GEMINI_MODEL }).then(h => {
    aiHealth = h;
    const icon = h.state === 'ok' ? '✅' : '❌';
    console.log(`   ${icon} ${h.state === 'ok' ? 'ON — ' : ''}${h.message}`);
    console.log('');
  });
}

// ── WHATSAPP SETUP (printed at start) ───────────────────────
function startWhatsApp() {
  console.log('──── 💬 WhatsApp Order Confirmation ────');
  console.log('   Mode: SAME BROWSER — CRM koi naya browser nahi kholta.');
  console.log('   WhatsApp aap ke apne browser ke logged-in WhatsApp Web tab se jata hai,');
  console.log('   "MA CRM WhatsApp" extension ke zariye. Ek dafa install karein:');
  console.log(`     chrome://extensions (ya edge://extensions) → Developer mode ON → Load unpacked → ${path.join(__dirname, 'whatsapp-extension')}`);
  console.log('');
}

// ── START SERVER ────────────────────────────────────────────
initDB().then(async () => {
  await waFlow.recoverInterrupted();
  cleanScreenshotTmp();
  setInterval(cleanScreenshotTmp, 60 * 60 * 1000).unref();
  // VPL 3-day reminders: check once shortly after start, then keep retrying (only parcels that are
  // still exactly 3 days old) until the browser's WhatsApp Web tab is ready.
  setTimeout(() => runVplReminders('startup'), 15000);
  setInterval(() => runVplReminders('retry'), VPL_RETRY_MS).unref();
  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║     MA CRM Server — Running ✅        ║');
    console.log(`║  Local: http://localhost:${PORT}         ║`);
    console.log('╚══════════════════════════════════════╝');
    console.log('');
    console.log('📂 Public folder mein index.html rakho');
    console.log(`📊 Report Page: /report   | Data: ${DATA_DIR}`);
    console.log('📊 Report API: /api/report/2026/5');
    console.log('🛑 Stop karne ke liye: Ctrl + C');
    console.log('');
    logAiSetup();
    startWhatsApp();
  });
}).catch(err => {
  console.error('❌ Server start nahi hua:', err);
  process.exit(1);
});
