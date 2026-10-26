// ════════════════════════════════════════════════════════════
//  MA CRM — storage.js : permanent copy of order screenshots in Supabase Storage.
//  Files still live on local disk for speed (WhatsApp reads them from there), but every
//  placed order's screenshot is ALSO saved to the private bucket, and is restored from
//  the bucket automatically if the local copy is gone (e.g. after a Render redeploy).
//  Not configured (no SUPABASE_URL / SUPABASE_SERVICE_KEY) → behaves exactly as before.
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

module.exports = function createStorage({ client } = {}) {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_KEY || '').trim();
  const bucket = (process.env.SUPABASE_BUCKET || 'crm-files').trim();
  let sb = client || null;
  if (!sb && url && key) {
    const { createClient } = require('@supabase/supabase-js');
    sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  const enabled = !!sb;

  async function put(objectKey, buffer, mime) {
    if (!enabled) return false;
    const { error } = await sb.storage.from(bucket).upload(objectKey, buffer, { contentType: mime || 'application/octet-stream', upsert: true });
    if (error) throw new Error('Supabase Storage upload failed: ' + error.message);
    return true;
  }

  async function remove(prefixKeys) {
    if (!enabled || !prefixKeys.length) return;
    const { error } = await sb.storage.from(bucket).remove(prefixKeys);
    if (error) console.warn('[storage] delete failed:', error.message);
  }

  // Makes sure <root>/<fileName> exists on disk, downloading it from the bucket if needed.
  async function ensureLocal(root, fileName) {
    const dest = path.join(root, fileName);
    try { await fs.promises.access(dest); return true; } catch (e) { /* missing locally */ }
    if (!enabled) return false;
    const { data, error } = await sb.storage.from(bucket).download(fileName);
    if (error || !data) { console.warn(`[storage] ${fileName} not in bucket:`, error && error.message); return false; }
    const buf = Buffer.from(await data.arrayBuffer());
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, buf);
    return true;
  }

  return { enabled, bucket, put, remove, ensureLocal };
};
