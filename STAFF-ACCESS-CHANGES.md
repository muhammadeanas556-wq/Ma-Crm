# Staff Access / RBAC update — change report

## 1. Files changed
| File | Change |
|---|---|
| `rbac.js` (new) | Permission list, default-deny staff route table, status → permission rules, tag cleaning, report buckets |
| `auth.js` | Session now loads the user's permissions from the DB on every request; API gate calls `rbac.routeAllowed()`; `/api/staff-orders` added to owner-only list |
| `server.js` | DB migrations, permission checks inside order routes, `POST /api/orders/tags`, `GET /api/staff-orders`, activity log, staff-safe `/api/users` and `/api/settings` |
| `public/index.html` | Permission-aware UI, staff permission controls, Staff Orders page, tags, staff dashboard, mobile layout fixes |

`ai-import.js`, `phone.js`, `whatsapp-sender.js`, `whatsapp-workflow.js`, `db.js`, `storage.js` are **not** touched.
Copy only the 4 files above (+ this note) into your full project.

## 2. Database changes (automatic, additive, safe)
Run on start-up for both Supabase Postgres and SQLite. Nothing is deleted or rewritten.
- `users.permissions TEXT` — JSON of the staff member's permissions.
- `orders.created_by INTEGER`, `orders.created_by_role TEXT` — who placed the order (set automatically by the server).
- `orders.updated_by INTEGER`, `orders.updated_at TEXT` — last user who edited / changed status / tags.
- `orders.tags TEXT DEFAULT ''` — order tags (comma separated).
- New table `order_activity` (order_id, user_id, user_role, user_name, action, detail, created_at) + indexes.
- One-time: staff accounts that existed before the update get the access they already had
  (View Orders, Monthly Report, all status changes) so nobody is locked out. Adjust them in Team → Edit.
- Old orders keep `created_by = NULL`; they are attributed to a staff member through the existing "Assign To Staff" field.

## 3. Staff permissions
View Orders · Create/Place Orders (incl. Screenshot Import) · Edit Orders · Change Order Tags ·
Change Order Status (Delivered/Cancelled) · Mark Paid · Mark Pending (Processing) · Process Returns · View Monthly Report.
Admin-only and never grantable: Staff Management, Admin Settings, Delete Orders, Backups, WhatsApp connection settings.

## 4. Admin features
- Team → Add/Edit Staff: permission checkboxes ("All orders" / "None" shortcuts); staff list shows each person's permissions.
- New **Staff Orders** page: Total / Pending / Paid / Returned / Completed / Cancelled cards; per-staff cards; staff selector;
  status tabs; date range (This month / Today / All time); order list (ID, customer, date, status, payment, tags, total,
  return, handled by); recent staff activity. All numbers come from the database on each load.
- Status pop-up now also offers Delivered (= Completed) and Cancelled.

## 5. Security / RBAC
- Every `/api` call by a staff account is checked on the server against a default-deny route list + that account's permissions.
  Unknown/new routes are refused for staff automatically.
- Inside the routes: staff can only set statuses they have permission for, cannot re-assign orders, their new orders are
  always owned by them, tag changes need Change Tags, missing fields never reset an order.
- Staff cannot reach staff management, settings, backups, reports API, deletes, password/profile endpoints, WhatsApp setup.
- `/api/users` gives staff only names/photos (no emails, no permissions of others); `/api/settings` gives staff only logo + store name.
- Permission changes apply instantly (read per request); deleting a staff account signs them out everywhere.

## 6. Mobile
- Order lists become stacked cards under 760 px (no sideways scrolling); touch targets ≥ 44 px.
- Pop-ups scroll on small screens (edit order Save button was unreachable before); Cancel buttons added.
- Team/Settings page stacks to one column; top bar compacts; filters wrap; Monthly Report rows become cards.
- Bottom bar and sidebar show only pages the user may open.
- Fixed an existing broken tag on the Team page that made "Product Management" and "Staff Management" cards appear
  at the bottom of every page — for staff too.

## 7. Still needs attention
- Tested locally with SQLite and stand-ins for `ai-import.js`, `phone.js`, `whatsapp-sender.js` (they were not in the zip).
  Test once on Render/Supabase: place one order as staff and confirm the WhatsApp step.
- Staff with View Orders see **all** orders (same as before). Restricting staff to only their own orders would be a further option.
- Products list is still stored per browser (existing behaviour), so a staff phone starts with the default products.
- Demo-account login (browser-only) is unchanged.
