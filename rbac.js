// ════════════════════════════════════════════════════════════
//  MA CRM — rbac.js : Role-Based Access Control for Staff accounts.
//
//  Roles:  admin → full access (unchanged behaviour)
//          staff → ONLY the permissions the Admin has ticked for that account
//
//  Two layers, both on the server:
//   1) routeAllowed()  — called by the API gate in auth.js for EVERY /api request.
//      Default-deny: a staff request to any route that is not listed in STAFF_ROUTES
//      is refused with 403, so a new/forgotten admin endpoint can never leak to staff.
//   2) Fine-grained checks inside the order routes (which status a staff member may
//      set, whether tags changed, etc.) via can() / canSetStatus().
//
//  Permissions are stored per user in users.permissions (JSON text) and are read from
//  the database on every request — a change by the Admin takes effect immediately.
// ════════════════════════════════════════════════════════════

// The catalogue the Admin sees in Staff Management (order matters: it is the UI order).
const PERMISSIONS = [
  { key: 'view_orders',     label: 'View Orders',            hint: 'Dashboard aur Clients & Orders list dekh sakta hai' },
  { key: 'create_orders',   label: 'Create / Place Orders',  hint: 'Naya order + Screenshot Import' },
  { key: 'edit_orders',     label: 'Edit Orders',            hint: 'Naam, number, product, amount, tracking ID' },
  { key: 'change_tags',     label: 'Change Order Tags',      hint: 'Order par tags lagana / hatana' },
  { key: 'change_status',   label: 'Change Order Status',    hint: 'Delivered (Completed) / Cancelled' },
  { key: 'mark_paid',       label: 'Mark Orders as Paid',    hint: 'Status → Paid' },
  { key: 'mark_pending',    label: 'Mark Orders as Pending', hint: 'Status → Processing' },
  { key: 'process_returns', label: 'Process Returns',        hint: 'Status → Return' },
  { key: 'view_reports',    label: 'View Monthly Report',    hint: 'Monthly Report page' },
];
const KEYS = new Set(PERMISSIONS.map(p => p.key));

// Admin-only areas — shown (locked) in the permission UI so it is clear they can never be granted.
const ADMIN_ONLY_FEATURES = ['Staff Management', 'Admin Settings', 'Delete Orders', 'Backups', 'WhatsApp connection settings'];

// What existing staff accounts could already do before this update (view lists, report page,
// change status from the status pop-up). Applied ONCE to staff rows that have no permissions yet,
// so nobody loses access on upgrade. The Admin can then tighten each account.
const LEGACY_STAFF = { view_orders: true, view_reports: true, change_status: true, mark_paid: true, mark_pending: true, process_returns: true };
// A newly created staff account when the Admin does not send a permission list.
const NEW_STAFF_DEFAULT = { view_orders: true };

// Statuses the CRM knows. The status pop-up uses these; existing data may contain others.
const STATUSES = ['Processing', 'Paid', 'Return', 'Delivered', 'Cancelled'];

function parse(text) {
  let obj = text;
  if (typeof text === 'string') { try { obj = JSON.parse(text); } catch (e) { obj = null; } }
  const out = {};
  if (obj && typeof obj === 'object') for (const k of KEYS) if (obj[k] === true) out[k] = true;
  return out;
}
// Only known keys, only `true` values — anything else sent by a browser is dropped.
const sanitize = obj => parse(obj && typeof obj === 'object' ? obj : {});
const serialize = obj => JSON.stringify(sanitize(obj));

const isAdmin = user => !!user && user.role === 'admin';
function can(user, key) {
  if (isAdmin(user)) return true;
  if (!user || user.role !== 'staff') return false;
  return !!(user.permissions && user.permissions[key] === true);
}
const canAny = (user, keys) => keys.some(k => can(user, k));

// Which permission a status change needs.
function statusPermission(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'paid') return 'mark_paid';
  if (s === 'processing' || s === 'pending') return 'mark_pending';
  if (s === 'return' || s === 'returned') return 'process_returns';
  return 'change_status';
}
function canSetStatus(user, status) {
  if (isAdmin(user)) return true;
  if (!STATUSES.includes(status)) return false;              // staff may only use the known statuses
  return can(user, statusPermission(status));
}

// ── Staff route table (default-deny). Admin bypasses it completely. ──
// `perm`: a permission key, an array (any one of them is enough), or null (any signed-in staff).
const R = (method, re, perm) => ({ method, re, perm });
const ANY_STATUS = ['change_status', 'mark_paid', 'mark_pending', 'process_returns'];
const STAFF_ROUTES = [
  R('GET',  /^\/api\/me$/, null),
  R('POST', /^\/api\/logout$/, null),
  R('GET',  /^\/api\/users$/, null),                          // reduced fields for staff (see server.js)
  R('GET',  /^\/api\/settings$/, null),                       // logo + store name only for staff
  R('GET',  /^\/api\/orders$/, 'view_orders'),
  R('POST', /^\/api\/orders\/add$/, 'create_orders'),
  R('POST', /^\/api\/clients\/save$/, 'create_orders'),
  R('POST', /^\/api\/orders\/update$/, 'edit_orders'),
  R('POST', /^\/api\/orders\/status$/, ANY_STATUS),
  R('POST', /^\/api\/orders\/tags$/, 'change_tags'),
  R('GET',  /^\/api\/orders\/\d+\/screenshots$/, 'view_orders'),
  R('GET',  /^\/api\/orders\/\d+\/screenshots\/\d+\/file$/, 'view_orders'),
  R('GET',  /^\/api\/orders\/\d+\/whatsapp$/, ['view_orders', 'create_orders']),
  R('POST', /^\/api\/orders\/\d+\/whatsapp\/retry$/, ['create_orders', 'edit_orders']),
  R('POST', /^\/api\/orders\/\d+\/whatsapp\/mark-sent$/, ['create_orders', 'edit_orders']),
  R('POST', /^\/api\/screenshots\/temp$/, ['create_orders', 'edit_orders']),
  R('GET',  /^\/api\/ai\/status$/, 'create_orders'),
  R('POST', /^\/api\/ai\/extract$/, 'create_orders'),
  R('GET',  /^\/api\/whatsapp\/session$/, ['create_orders', 'edit_orders', 'view_orders']),
];

function routeAllowed(user, method, path) {
  if (isAdmin(user)) return true;
  if (!user || user.role !== 'staff') return false;           // unknown role → nothing
  const m = method === 'HEAD' ? 'GET' : method;
  const rule = STAFF_ROUTES.find(r => r.method === m && r.re.test(path));
  if (!rule) return false;
  if (rule.perm === null) return true;
  return Array.isArray(rule.perm) ? canAny(user, rule.perm) : can(user, rule.perm);
}

// ── Order tags: "Urgent, COD" / ["Urgent","COD"] → "Urgent,COD" (trimmed, de-duplicated, max 10 × 30 chars) ──
function cleanTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  const seen = new Set(), out = [];
  for (const raw of list) {
    const t = String(raw || '').replace(/[,\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push(t);
    if (out.length >= 10) break;
  }
  return out.join(',');
}

// ── Reporting buckets (Staff Orders section) ──
function statusBucket(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'paid') return 'paid';
  if (s === 'return' || s === 'returned') return 'returned';
  if (s === 'delivered' || s === 'completed') return 'completed';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  return 'pending';                                           // Processing / pending / anything new
}
function paymentStatus(o) {
  const amount = Number(o.amount) || 0, advance = Number(o.advance) || 0;
  if (String(o.status || '').toLowerCase() === 'paid' || (amount > 0 && advance >= amount)) return 'Paid';
  if (advance > 0) return 'Partial';
  return 'Unpaid';
}

module.exports = {
  PERMISSIONS, ADMIN_ONLY_FEATURES, LEGACY_STAFF, NEW_STAFF_DEFAULT, STATUSES,
  parse, sanitize, serialize, isAdmin, can, canAny, statusPermission, canSetStatus,
  routeAllowed, cleanTags, statusBucket, paymentStatus,
};
