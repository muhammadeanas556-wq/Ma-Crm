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
