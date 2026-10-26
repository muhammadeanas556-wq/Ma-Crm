// ════════════════════════════════════════════════════════════
//  MA CRM — auth.js : server-side sessions, password hashing,
//  private-network allowlist, CSRF origin check, API gate.
//  Node built-ins only. Sessions live in the SQLite `sessions` table
//  (token stored only as a SHA-256 hash) so they survive restarts.
// ════════════════════════════════════════════════════════════
const crypto = require('crypto');
const rbac = require('./rbac');

const IDLE_MS = (Number(process.env.SESSION_IDLE_DAYS) || 7)  * 864e5;   // logged out after N idle days
const MAX_MS  = (Number(process.env.SESSION_MAX_DAYS)  || 30) * 864e5;   // hard limit, then log in again
const PUBLIC_API = new Set(['/api/login', '/api/health']);
// Owner (role 'admin') only
const OWNER_ONLY = [/^\/api\/settings\/set/, /^\/api\/staff(\/|$)/, /^\/api\/whatsapp\/session\/logout/, /^\/api\/backup/, /^\/api\/users\/update/, /^\/api\/change-password/, /^\/api\/orders\/\d+$/, /^\/api\/report(\/|$)/, /^\/api\/staff-orders(\/|$)/];

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const clean = ip => String(ip || '').replace(/^::ffff:/, '');
const isLoopback = ip => ip === '127.0.0.1' || ip === '::1';

// ── password hashing (scrypt) ───────────────────────────────
const isHashed = s => typeof s === 'string' && s.startsWith('scrypt$');
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  if (!isHashed(stored)) return false;
  const [, s, h] = stored.split('$');
  const a = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── which network addresses may talk to the server at all ───
function allowedIp(raw) {
  const ip = clean(raw).toLowerCase();
  if (isLoopback(ip)) return true;                                           // this PC
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;      // Tailscale IPv4 (100.64.0.0/10)
  if (ip.startsWith('fd7a:115c:a1e0:')) return true;                         // Tailscale IPv6
  if (process.env.ALLOW_LAN === '1' &&
      (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip))) return true;
  return false;
}

const cookieOf = (req, n) => { const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + n + '=([^;]+)')); return m && m[1]; };
const deny = (res, code, message) => res.status(code).json({ success: false, code: code === 401 ? 'auth_required' : 'forbidden', message });

module.exports = function createAuth({ dbRun, dbGet }) {
  const fails = new Map();   // ip → {n, until}

  async function init() {
    await dbRun(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, role TEXT NOT NULL,
      created BIGINT NOT NULL, last_seen BIGINT NOT NULL)`);
    await dbRun(`DELETE FROM sessions WHERE created < ? OR last_seen < ?`, [Date.now() - MAX_MS, Date.now() - IDLE_MS]);
  }

  async function createSession(res, user) {
    const token = crypto.randomBytes(32).toString('hex'), now = Date.now();
    await dbRun(`INSERT INTO sessions (token_hash,user_id,role,created,last_seen) VALUES (?,?,?,?,?)`, [sha(token), user.id, user.role, now, now]);
    res.setHeader('Set-Cookie', `crm_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(MAX_MS / 1000)}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  }
  async function destroySession(req, res) {
    const t = cookieOf(req, 'crm_sid');
    if (t) await dbRun(`DELETE FROM sessions WHERE token_hash=?`, [sha(t)]);
    res.setHeader('Set-Cookie', `crm_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  }
  async function sessionOf(req) {
    const t = cookieOf(req, 'crm_sid'); if (!t) return null;
    const s = await dbGet(`SELECT s.user_id, u.role, u.name, u.email, u.permissions, s.created, s.last_seen
                           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash=?`, [sha(t)]);
    const now = Date.now();
    if (!s || now - s.created > MAX_MS || now - s.last_seen > IDLE_MS) {
      if (s) await dbRun(`DELETE FROM sessions WHERE token_hash=?`, [sha(t)]);
      return null;
    }
    if (now - s.last_seen > 60000) dbRun(`UPDATE sessions SET last_seen=? WHERE token_hash=?`, [now, sha(t)]).catch(() => {});
    // role + permissions come from the DB on every request, never from the browser
    return { id: s.user_id, role: s.role, name: s.name, email: s.email,
             permissions: s.role === 'admin' ? null : rbac.parse(s.permissions) };
  }

  // 1) only this PC + your Tailscale network may connect
  const network = (req, res, next) => {
    if (allowedIp(req.socket.remoteAddress)) return next();
    res.status(403).type('text').send('Forbidden');
  };

  // 2) every /api route needs a valid session (+ CSRF origin check, + owner-only list)
  const gate = async (req, res, next) => {
    const path = req.path;
    if (!path.startsWith('/api/')) return next();
    // WhatsApp extension bridge: it has no login, so it is accepted from THIS PC only
    if (path.startsWith('/api/wa-bridge/')) {
      const expected = process.env.WA_BRIDGE_TOKEN || '';
      const supplied = req.get('X-MACRM-BRIDGE-TOKEN') || '';
      // For hosted deployments an unguessable token is mandatory; localhost without a
      // bridge token retains support for the original local-only browser extension.
      if (!expected && isLoopback(clean(req.socket.remoteAddress))) return next();
      if (expected.length >= 32 && supplied.length === expected.length &&
          crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return next();
      return deny(res, 403, 'WhatsApp bridge authentication required');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      let host = ''; try { host = new URL(req.headers.origin).host; } catch (e) {}
      if (host !== req.headers.host) return deny(res, 403, 'Cross-site request blocked');
    }
    if (PUBLIC_API.has(path)) return next();
    try {
      const user = await sessionOf(req);
      if (!user) return deny(res, 401, 'Session expired. Please sign in again.');
      if (user.role !== 'admin' && OWNER_ONLY.some(r => r.test(path))) return deny(res, 403, 'Owner access only');
      // Staff: default-deny route table + the account's own permissions (rbac.js)
      if (!rbac.routeAllowed(user, req.method, path)) return deny(res, 403, 'Aap ko is kaam ki permission nahi hai (permission required).');
      req.user = user; next();
    } catch (e) { console.error('[auth]', e.message); deny(res, 500, 'Server error'); }
  };

  // login brute-force limiter: 8 failures → 15 min lock per address
  const loginAllowed = ip => { const f = fails.get(ip); return !f || f.until < Date.now() || f.n < 8; };
  const loginFailed  = ip => { const f = fails.get(ip) || { n: 0 }; f.n = (f.until && f.until < Date.now()) ? 1 : f.n + 1; f.until = Date.now() + 15 * 60 * 1000; fails.set(ip, f); };
  const loginOk      = ip => fails.delete(ip);

  return { init, createSession, destroySession, sessionOf, network, gate, loginAllowed, loginFailed, loginOk, hashPassword, verifyPassword, isHashed, allowedIp };
};
