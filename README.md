# MA CRM — GitHub-ready Node.js application

This package includes the user-supplied CRM frontend, monthly report, Express/SQLite backend, AI extraction helpers, and WhatsApp browser extension. It was prepared for Node hosting; uploading to GitHub **does not** put the CRM online by itself.

## Deploy on Render + Supabase (recommended — no paid disk needed)

1. Supabase: create a project and a **private** Storage bucket named `crm-files`.
2. Render → Environment: `DATABASE_URL` (Supabase **Session pooler** string), `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (secret key), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12+ chars), `NODE_ENV=production`, `TZ=Asia/Karachi`; optionally `GEMINI_API_KEY`, `WA_BRIDGE_TOKEN`.
3. Deploy. Tables are created automatically; the first admin comes from `ADMIN_EMAIL`/`ADMIN_PASSWORD`.
4. Orders, users, logo, profile photos and settings live in Supabase Postgres; placed-order screenshots are copied to the `crm-files` bucket. Redeploys no longer erase them. `DATA_DIR` is not needed.
5. Without `DATABASE_URL` the app falls back to a local SQLite file (needs a persistent disk).

## Deploy on Railway (or another Node.js host with persistent storage)

1. Create a **private** GitHub repository (this CRM contains private business application code). Extract this ZIP first; extract the ZIP and upload the **extracted files** at the repository root, not the ZIP file itself. Never upload your real `env` file or database.
2. In Railway, create a project from that repository and deploy it as a Node service. Build command: `npm ci`; start command: `npm start` (configured). Expose an HTTPS public domain.
3. Add a **persistent volume**, mounted at `/data`. Set `DATA_DIR=/data` as a private environment variable. Otherwise orders, screenshots and sessions can disappear on a redeploy or restart.
4. Set the private variables `NODE_ENV=production`, `TZ=Asia/Karachi`, `ADMIN_NAME`, `ADMIN_EMAIL`, and a unique `ADMIN_PASSWORD` of at least 12 characters. ADMIN_EMAIL and ADMIN_PASSWORD are used only to create the **first** administrator on an empty database; later password changes in the CRM are saved in SQLite.
5. Optional screenshot AI: set a **new** `GEMINI_API_KEY`. The original uploaded `env` file was intentionally **NOT** included. Rotate/revoke that old key because it was shared in a file.
6. Visit the deployed URL and log in. Test adding a sample order and check that it persists after a deploy/restart. Your old CRM database was not uploaded, so the deployed CRM starts **empty**. To retain existing orders, separately and privately migrate `macrm.db` (plus screenshots), with the service stopped during copying.
7. Optional WhatsApp extension: see below and `whatsapp-extension/options.html`. Configure a random 32+ character `WA_BRIDGE_TOKEN` on the host and in extension options. Without this setup, online WhatsApp sending and VPL reminders will not work even though the CRM itself works.

## Use locally

Install Node.js 22+, run `npm ci`, create `.env` from `.env.example` and set your own ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters), then run `npm start`. Open http://localhost:3000. (You may set NODE_ENV=development for local HTTP so cookies are not Secure.)

## WhatsApp extension — after deploying

Open Chrome → Extensions → Developer mode → **Load unpacked**, select the `whatsapp-extension` directory. In its **Details → Extension options**, enter your deployed CRM HTTPS URL and the same random `WA_BRIDGE_TOKEN` from your host's environment variables; then refresh both the CRM and WhatsApp Web tabs. WhatsApp sending only works with your browser running, the extension enabled, and WhatsApp Web logged in. Browser-driven sending is fragile if WhatsApp updates its interface: test carefully.

## Security / operational notes

- All private API credentials belong in hosting environment variables, never GitHub. `.gitignore` excludes local environment files, databases, screenshots and node_modules.
- Admin/staff passwords are hashed on the server and HTTP-only session cookies are used. No default live administrator password is shipped. Login attempts are rate limited. The included demo UI uses local sample data and cannot access production APIs.
- `macrm.db`, `order-screenshots/`, and editable WhatsApp templates are stored under DATA_DIR. Back up your attached volume securely. This package contains **code only**, not your current CRM's records or existing local DB.
- This is an adaptation of user-supplied code, not a certified production security assessment. Restrict access to trusted staff, use HTTPS, maintain backups, and run testing before entering sensitive customer data.
- GitHub Pages and a plain Netlify static site do **not** run the Node/SQLite API. A Node host with persistent disk is required.
- The extension requires broad HTTPS network permission to reach a user-selected CRM domain, but only injects its CRM helper into a configured site. Install only your own copy and avoid sharing its bridge token.

## Staff access, order isolation & profile pictures (update)

**What changed**
- Every new order stores its owner: `created_by_user_id`, `created_by_role` (`admin`/`staff`), `created_by_name`, plus `updated_at`. The server sets these from the logged-in session and never changes them on edit (Staff or Admin).
- **Staff** see, search, filter, edit and change status only on orders they placed. This is enforced in SQL on the server for `GET /api/orders`, `GET /api/orders/:id`, status/update, screenshots, WhatsApp status/retry/mark-sent (incl. Gemini message retries) and the VPL list. Other orders return **403 Access denied**, the same answer as for an order ID that doesn't exist. Delete and Share stay Admin-only.
- Staff can now **Add Order** (manual form and Gemini screenshot import). Their orders are automatically assigned to them. Staff menu: Dashboard · Add Order · My Orders · My Report · My Profile.
- Staff only receive their own user record and the branding settings (logo, store name). Team/Staff management, Staff Orders, the report API, backup and settings stay Admin-only on the server.
- **Admin → Staff Orders** (new menu): totals (Total / Pending / Delivered / Return / Paid / Unpaid), staff-wise cards with profile pictures, and combinable filters (staff, status, date range, Order ID / customer / phone search). Any order opens in the existing editor. The Admin's own orders are never counted here. The existing *Clients & Orders* page also gets an *All / My orders / Staff orders* selector and a "👤 name" tag on staff orders.
- **Account status** per staff member (Team → Edit → Account Status). A disabled account can't log in, and its open sessions end immediately. Its orders remain visible to Admin.
- **Profile pictures**: each user has their own photo (`users.photo`), saved through `POST /api/me/photo` and returned by `/api/me`, so it shows after refresh and re-login. Staff upload theirs on *My Profile*. Only real PNG/JPG/WEBP images are accepted, and a missing or broken image falls back to the initial. The CRM logo is separate and is no longer drawn into the login ring by profile code.
- Fixed: the Team page's "My Profile" card was missing its header tags. That pushed *Product Management* and *Staff Management* outside the Team page, so they showed under every page.
- The browser's offline order cache is now kept per user, so a shared browser can't show one account's cached orders to another.

**Existing data**: nothing is deleted or rewritten. Columns are added automatically on start. Orders created before this update have no owner and are treated as Admin orders, so Staff never see them and Admin sees them as before.

**Definitions used in counts**: Pending = status *Processing*; Unpaid = any order not marked *Paid*.

## Send Dispatch Message (WhatsApp click-to-chat) & staff-account lockdown (update)

**Send Dispatch Message (Method 1)**
- Where: the **📤 Dispatch** chip under each order's Tracking ID (Clients & Orders, My Orders, Dashboard), the **Send Dispatch Message** button on the panel shown right after **Place Order**, and the same button in **Edit Order**.
- The panel loads the *saved* order from `GET /api/orders/:id/dispatch`: the customer's WhatsApp number (normalised by `phone.js` with its own country code; if the phone was edited after Place Order, the edited number is used), the message, and the original order image(s).
- The message uses your existing `whatsapp-message.txt` template (same placeholders, e.g. `[Customer Name]`, `[Tracking ID]`), filled from the current saved order. Gemini is never used for it. If the template has no `[Tracking ID]`, a `Tracking ID:` line is added so the message is never sent without it. The message can be edited in the panel before opening WhatsApp.
- **Open WhatsApp Chat** opens `web.whatsapp.com/send?phone=…&text=…` (or `wa.me/…` on a phone) in a single reusable tab, with the message pre-filled. **Copy image** puts the original image on the clipboard, so you paste it into the chat with Ctrl+V. **Download original** saves the exact original file, and **Open Original Image** opens it. Then press Send in WhatsApp and click **Mark as Sent**.
- Statuses (separate columns, `dispatch_*`): *Ready to Send* → *WhatsApp Opened* → *Sent* (only when a person confirms it; it can be undone). The order status and courier status are never changed by this. The automatic extension sender (`wa_*`) is unchanged; if it already sent the order, the panel says so.
- Missing or invalid phone, or missing tracking ID: the panel explains the problem and offers **Edit Order**. With no saved image, the message can still be sent.
- Access: the same ownership rules as the rest of the CRM. Admin can use it on any order, and staff only on orders they placed. The image URLs need a login and are ownership-checked; they are not public.
- Limitation: a WhatsApp link cannot attach a file or press Send. Pasting or attaching the image and pressing Send stays manual.

**Staff can no longer create staff accounts by any route**
- `/api/staff/add`, `/api/staff/update` and `DELETE /api/staff/:id` now also check for Admin on the route itself (403 for staff).
- Fixed in `auth.js`: Express matches routes case-insensitively, but the login gate did not. `/API/staff/add` skipped the login check entirely, and `/api/Staff/add` skipped the owner-only list. The gate now lower-cases the path, which also closes the same hole on `/API/settings/set`, `/API/backup` and other paths.
- The Staff Management card and the Add/Edit/Delete Staff dialogs are Admin-only in the UI, and their functions refuse to run for staff.

**Database**: 6 new nullable columns on `orders` (`dispatch_status`, `dispatch_phone`, `dispatch_opened_at`, `dispatch_sent_at`, `dispatch_by_user_id`, `dispatch_by_name`), added automatically on start. Nothing existing is changed or deleted.
