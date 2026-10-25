// ════════════════════════════════════════════════════════════
//  MA CRM — WhatsApp order-confirmation workflow
//
//  Runs ONLY for an order that is already saved in the database.
//  Callers: server.js placeOrder() — used by BOTH the AI import and the
//  manual form, after the order + screenshots are committed — and
//  "Retry WhatsApp". It works from the saved order data only; it never
//  looks at whether Gemini was used.
//  Upload, Gemini extraction, editing and review never reach here.
//
//  Order → wa_status:  NULL → pending → processing → sent | failed
//  workflow_state:     ORDER_PLACED → WHATSAPP_PENDING → WHATSAPP_OPENED
//                      → WHATSAPP_SENT | WHATSAPP_FAILED
//
//  This file only ever writes wa_* / workflow_state columns.
//  It never inserts, rolls back or deletes an order.
// ════════════════════════════════════════════════════════════
const fs     = require('fs');
const path   = require('path');
const phone  = require('./phone');
const sender = require('./whatsapp-sender');

const STEPS = ['message', 'phone', 'open', 'chat', 'attach', 'send'];
const ACTIVE = ['pending', 'processing', 'opening'];   // 'opening' = older CRM versions

module.exports = function createWorkflow({ dbRun, dbGet, dbAll, screenshotRoot, gemini }) {
  const running = new Set();   // in-process guard; the DB compare-and-set below is the real lock

  // ── helpers ───────────────────────────────────────────────
  const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const parse = s => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };

  async function setProgress(id, step, state) {
    const row = await dbGet(`SELECT wa_progress FROM orders WHERE id=?`, [id]);
    const p = parse(row && row.wa_progress) || {};
    p[step] = state;
    await dbRun(`UPDATE orders SET wa_progress=? WHERE id=?`, [JSON.stringify(p), id]);
  }

  async function fail(id, step, code, message) {
    await setProgress(id, step, 'failed').catch(e => console.error(`[WhatsApp] order #${id} progress save:`, e.message));
    await dbRun(
      `UPDATE orders SET wa_status='failed', workflow_state='WHATSAPP_FAILED', wa_step=?, wa_error_code=?, wa_error=? WHERE id=?`,
      [step, code, String(message || '').slice(0, 400), id]);
    console.warn(`[WhatsApp] order #${id} FAILED at ${step} — ${code}: ${message}`);
  }

  // ── message ───────────────────────────────────────────────
  function linesText(snap) {
    const lines = (snap.lines || []).filter(l => l && l.product);
    if (!lines.length) return snap.detail || 'your items';
    return lines.map(l => `${l.product} x ${l.qty}`).join(', ');
  }

  // ── YOUR message template: whatsapp-message.txt (edit freely, no restart needed) ──
  const TEMPLATE_FILE = path.join(process.env.DATA_DIR || __dirname, 'whatsapp-message.txt');
  const DEFAULT_TEMPLATE = [
    'Hello [Customer Name],', '',
    'Your order [Order ID] has been dispatched successfully.', '',
    'Tracking ID: [Tracking ID]', 'Order: [Order Details]', 'Total: Rs. [Amount]', '',
    'Your order will be delivered to you within 1–2 working days.', '',
    'Thank you for shopping with us.',
  ].join('\n');

  function readTemplate() {
    try { return fs.readFileSync(TEMPLATE_FILE, 'utf8'); }
    catch (e) {
      if (e.code !== 'ENOENT') throw Object.assign(new Error('whatsapp-message.txt parh nahi saka: ' + e.message), { code: 'template' });
      fs.writeFileSync(TEMPLATE_FILE, DEFAULT_TEMPLATE + '\n');
      console.log('[WhatsApp] whatsapp-message.txt bana di (default template)');
      return DEFAULT_TEMPLATE;
    }
  }

  // Fills the template from the SAVED order. A line whose placeholder has no value
  // (e.g. no tracking ID yet) is left out instead of sending an empty "Tracking ID:".
  function templateMessage(snap) {
    const num = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const values = {
      'customer name': snap.name,
      'order id':      snap.order_code,
      'tracking id':   snap.tracking_id,
      'order details': linesText(snap),
      'amount':        num(snap.amount),
      'advance':       snap.advance > 0 ? num(snap.advance) : '',
      'remaining':     num(Number(snap.amount || 0) - Number(snap.advance || 0)),
      'address':       snap.address,
      'phone':         snap.phone,
      'business name': snap.business,
    };
    const unknown = [];
    const lines = readTemplate().replace(/\r\n/g, '\n').split('\n').map(line => {
      let empty = false;
      const out = line.replace(/\[([^\]]+)\]/g, (m, key) => {
        const k = key.trim().toLowerCase();
        if (!(k in values)) { unknown.push(m); return m; }
        const v = String(values[k] == null ? '' : values[k]).trim();
        if (!v) empty = true;
        return v;
      });
      return empty ? null : out;
    }).filter(l => l !== null);
    if (unknown.length) {
      throw Object.assign(new Error(`whatsapp-message.txt mein yeh placeholder samajh nahi aaya: ${[...new Set(unknown)].join(', ')}`), { code: 'template' });
    }
    const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw Object.assign(new Error('whatsapp-message.txt khali hai'), { code: 'template' });
    return text;
  }

  function standardMessage(snap) {
    const parts = [
      `Hello ${snap.name},`,
      `We have received your order ${snap.order_code} for ${linesText(snap)}.`,
      `Total amount: ${rs(snap.amount)}.` + (snap.advance > 0 ? ` Advance received: ${rs(snap.advance)}. Remaining: ${rs(snap.amount - snap.advance)}.` : ''),
      'Please confirm your order so we can proceed with dispatch.',
      'Thank you.' + (snap.business ? `\n${snap.business}` : ''),
    ];
    return parts.join('\n\n');
  }

  function checkMessage(text, snap) {
    let t = String(text || '').trim()
      .replace(/^```[a-z]*\s*/i, '').replace(/```$/, '')
      .replace(/^["“]|["”]$/g, '')
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .trim();
    if (t.length < 20) throw Object.assign(new Error('Gemini ka message bohat chhota tha'), { code: 'empty' });
    if (t.length > 900) throw Object.assign(new Error('Gemini ka message bohat lamba tha'), { code: 'invalid' });
    if (/[\[{<]\s*[A-Za-z _]+\s*[\]}>]/.test(t)) throw Object.assign(new Error('Message mein placeholder reh gaya'), { code: 'invalid' });
    if (/https?:\/\/|www\./i.test(t)) throw Object.assign(new Error('Message mein link tha'), { code: 'invalid' });
    const amt = Number(snap.amount);
    const forms = [amt.toLocaleString('en-US'), String(amt)];
    if (!forms.some(f => t.includes(f))) throw Object.assign(new Error('Message mein total amount sahi nahi tha'), { code: 'invalid' });
    return t;
  }

  async function geminiMessage(snap) {
    const keys = (gemini.apiKeys && gemini.apiKeys.length ? gemini.apiKeys : [gemini.apiKey]).filter(Boolean);
    const nv = gemini.nvidia && gemini.nvidia.apiKey ? gemini.nvidia : null;
    if (!keys.length && !nv) throw Object.assign(new Error('Gemini API key server par set nahi'), { code: 'config' });
    const facts = {
      customer_name: snap.name,
      order_id: snap.order_code,
      items: (snap.lines || []).map(l => ({ product: l.product, quantity: l.qty })),
      total_amount: rs(snap.amount),
      advance_paid: snap.advance > 0 ? rs(snap.advance) : null,
      remaining_cod: snap.advance > 0 ? rs(snap.amount - snap.advance) : null,
      business_name: snap.business || null,
    };
    const prompt = [
      'Write a WhatsApp order-confirmation message from a small online shop to its customer.',
      `Language: ${gemini.language}.`,
      'Use ONLY the facts in the JSON below. Do not invent prices, discounts, dates, delivery times, links or contact details.',
      'Start with "Hello <customer_name>,". Mention the order ID, each item with its quantity, and the total amount written exactly as given.',
      'If advance_paid is not null, mention the advance and the remaining amount.',
      'Ask the customer to confirm the order so it can be dispatched, then thank them. Sign with business_name if it is not null.',
      'Short and professional: at most 70 words, 3-5 short paragraphs separated by blank lines.',
      'Plain text only: no markdown headings, no emojis, no placeholders, no quotation marks around the message.',
      'Reply with the message text only.',
      '',
      JSON.stringify(facts, null, 2),
    ].join('\n');

    // Every Gemini key × model first, then NVIDIA — the first one that answers wins.
    const attempts = [];
    keys.forEach((key, ki) => gemini.models.forEach(model => attempts.push({ kind: 'gemini', key, model, label: `${model} (key ${ki + 1})` })));
    if (nv) attempts.push({ kind: 'nvidia', key: nv.apiKey, model: nv.model, label: `NVIDIA ${nv.model}` });
    const badKeys = new Set();
    let lastErr;
    for (const a of attempts) {
      if (badKeys.has(a.key)) continue;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      try {
        let text = '';
        if (a.kind === 'gemini') {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(a.model)}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': a.key },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
            }),
            signal: ctrl.signal,
          });
          const body = await r.json().catch(() => ({}));
          if (!r.ok) {
            const msg = (body.error && body.error.message) || `HTTP ${r.status}`;
            throw Object.assign(new Error(msg), { code: r.status === 429 ? 'rate_limited' : (r.status >= 500 ? 'upstream' : 'bad_request') });
          }
          const parts = (((body.candidates || [])[0] || {}).content || {}).parts || [];
          text = parts.filter(p => p && !p.thought && typeof p.text === 'string').map(p => p.text).join('');
        } else {
          const r = await fetch(`${String(nv.baseUrl || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${a.key}` },
            body: JSON.stringify({ model: a.model, stream: false, temperature: 0.4, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
            signal: ctrl.signal,
          });
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw Object.assign(new Error(`NVIDIA HTTP ${r.status}`), { code: r.status === 429 ? 'rate_limited' : (r.status >= 500 ? 'upstream' : 'bad_request') });
          text = String((((body.choices || [])[0] || {}).message || {}).content || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
        }
        return checkMessage(text, snap);
      } catch (e) {
        lastErr = e.name === 'AbortError' ? Object.assign(new Error('Gemini ne time par jawab nahi diya'), { code: 'timeout' }) : e;
        console.warn(`[WhatsApp] message via ${a.label} failed: ${lastErr.message}`);
        if (lastErr.code === 'bad_request' && /API key/i.test(lastErr.message)) badKeys.add(a.key);
      } finally { clearTimeout(timer); }
    }
    throw Object.assign(lastErr || new Error('Gemini message nahi bana saka'), { code: (lastErr && lastErr.code) || 'upstream' });
  }

  const isQuota = e => !!e && (e.code === 'rate_limited' || /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(e.message || ''));

  // ── the job ───────────────────────────────────────────────
  async function run(id, opts) {
    if (running.has(id)) return;
    running.add(id);
    try {
      const o = await dbGet(`SELECT * FROM orders WHERE id=?`, [id]);
      if (!o || o.wa_status !== 'pending') return;
      const snap = parse(o.wa_snapshot);
      if (!snap) return fail(id, 'message', 'no_snapshot', 'Order ka saved data nahi mila');

      // 1) Message — from the data frozen when the order was saved
      let message = o.wa_message;
      if (!message) {
        await setProgress(id, 'message', 'running');
        // Default: your template (whatsapp-message.txt). WHATSAPP_MESSAGE=gemini → Gemini writes it instead.
        let source = gemini.mode === 'gemini' && (gemini.apiKey || (gemini.nvidia && gemini.nvidia.apiKey)) && !opts.standard ? 'gemini' : 'template';
        try {
          message = source === 'template' ? templateMessage(snap) : await geminiMessage(snap);
        } catch (e) {
          if (e.code === 'template') return fail(id, 'message', 'template', e.message);
          // Quota / rate limit is Google's limit, not a problem with the order → use the standard
          // message (same facts, fixed wording) so WhatsApp still goes out.
          if (!(isQuota(e) || ['upstream', 'timeout', 'rate_limited'].includes(e.code))) return fail(id, 'message', e.code || 'upstream', e.message);
          console.warn(`[WhatsApp] order #${id}: Gemini busy / quota used up — using the standard message`);
          source = 'standard';
          message = standardMessage(snap);
        }
        await dbRun(`UPDATE orders SET wa_message=?, wa_message_source=? WHERE id=?`, [message, source, id]);
      }
      await setProgress(id, 'message', 'done');

      // 2) Phone — normalized again by the dedicated utility, never guessed
      const ph = phone.normalize(snap.wa_phone);
      if (!ph.ok) return fail(id, 'phone', 'bad_phone', ph.reason);
      await setProgress(id, 'phone', 'done');

      // 3) Claim the send. Only ONE request can move pending → opening.
      const claim = await dbRun(
        `UPDATE orders SET wa_status='processing', workflow_state='WHATSAPP_OPENED' WHERE id=? AND wa_status='pending'`, [id]);
      if (claim.changes !== 1) return;

      const shots = await dbAll(`SELECT * FROM order_screenshots WHERE order_id=? ORDER BY position ASC`, [id]);
      const files = shots.map(s => ({
        path: path.join(screenshotRoot, s.file_name), mime: s.mime, sha256: s.sha256,
        name: s.original_name || path.basename(s.file_name),
      }));

      try {
        await sender.sendOrder({
          number: ph.number, files, caption: message,
          startAt: o.wa_parts_sent || 0,
          onStep: (step, state) => setProgress(id, step, state),
          onPartSent: i => dbRun(`UPDATE orders SET wa_parts_sent=? WHERE id=?`, [i + 1, id]),
        });
      } catch (e) {
        return fail(id, e.step || 'open', e.code || 'error', e.message);
      }

      await dbRun(
        `UPDATE orders SET wa_status='sent', workflow_state='WHATSAPP_SENT', wa_sent_at=CURRENT_TIMESTAMP,
           wa_step='send', wa_error=NULL, wa_error_code=NULL WHERE id=?`, [id]);
      console.log(`[WhatsApp] ✅ order #${id} sent to +${ph.number} (${files.length} screenshot${files.length === 1 ? '' : 's'})`);
    } catch (e) {
      console.error(`[WhatsApp] order #${id} unexpected error:`, e && e.stack || e);
      await fail(id, 'open', 'error', e.message).catch(x => console.error(`[WhatsApp] order #${id} could not record failure:`, x.message));
    } finally {
      running.delete(id);
    }
  }

  // ── public API ────────────────────────────────────────────
  // THE common WhatsApp function. Called by placeOrder() (AI + manual) AFTER the order and its
  // screenshots are committed. Returns true if it started; the job then runs in the background.
  async function processWhatsAppForOrder(id) {
    const claim = await dbRun(
      `UPDATE orders SET wa_status='pending', workflow_state='WHATSAPP_PENDING', wa_progress='{}',
         wa_attempts=COALESCE(wa_attempts,0)+1, wa_started_at=CURRENT_TIMESTAMP
       WHERE id=? AND wa_status IS NULL AND wa_snapshot IS NOT NULL`, [id]);
    if (claim.changes === 1) setImmediate(() => run(id, {}));
    return claim.changes === 1;
  }

  // "Retry WhatsApp" — never creates an order; refuses if already sent or running.
  async function retry(id, { standard = false } = {}) {
    const o = await dbGet(`SELECT id, wa_status, wa_step, wa_snapshot, wa_parts_sent FROM orders WHERE id=?`, [id]);
    if (!o) return { ok: false, code: 'not_found', message: 'Order nahi mila' };
    if (!o.wa_snapshot) return { ok: false, code: 'not_whatsapp', message: 'Is order ke saath WhatsApp workflow nahi hai (screenshot se nahi bana)' };
    if (o.wa_status === 'sent') return { ok: false, code: 'already_sent', message: 'WhatsApp pehle hi bheja ja chuka hai — dobara nahi bhejenge' };
    if (ACTIVE.includes(o.wa_status) || running.has(id)) return { ok: false, code: 'running', message: 'WhatsApp abhi bheja ja raha hai' };

    // Regenerate the message only if generating it was what failed (or user picked the standard one)
    const keepMessage = !standard && o.wa_step !== 'message';
    const p = {};
    if (keepMessage) p.message = 'done';
    const claim = await dbRun(
      `UPDATE orders SET wa_status='pending', workflow_state='WHATSAPP_PENDING', wa_error=NULL, wa_error_code=NULL,
         wa_progress=?, wa_attempts=COALESCE(wa_attempts,0)+1, wa_started_at=CURRENT_TIMESTAMP
         ${keepMessage ? '' : ', wa_message=NULL, wa_message_source=NULL'}
       WHERE id=? AND (wa_status='failed' OR wa_status IS NULL)`, [JSON.stringify(p), id]);
    if (claim.changes !== 1) return { ok: false, code: 'running', message: 'Retry shuru nahi ho saka — status badal chuka hai' };
    setImmediate(() => run(id, { standard }));
    return { ok: true };
  }

  // User checked WhatsApp and the message is there → stop offering Retry.
  async function markSent(id) {
    const r = await dbRun(
      `UPDATE orders SET wa_status='sent', workflow_state='WHATSAPP_SENT', wa_sent_at=CURRENT_TIMESTAMP,
         wa_error=NULL, wa_error_code=NULL, wa_message_source=COALESCE(wa_message_source,'manual')
       WHERE id=? AND wa_status='failed'`, [id]);
    return r.changes === 1;
  }

  async function getStatus(id) {
    const o = await dbGet(`SELECT id, month, year, workflow_state, wa_status, wa_step, wa_progress, wa_error, wa_error_code,
        wa_message, wa_message_source, wa_phone, wa_parts_sent, wa_sent_at, wa_attempts, wa_snapshot
      FROM orders WHERE id=?`, [id]);
    if (!o) return null;
    const snap = parse(o.wa_snapshot) || {};
    const shots = await dbGet(`SELECT COUNT(*) AS n FROM order_screenshots WHERE order_id=?`, [id]);
    const ph = o.wa_phone ? phone.normalize(o.wa_phone) : null;
    return {
      order_id: o.id, order_code: snap.order_code || null,
      workflow_state: o.workflow_state, status: o.wa_status, step: o.wa_step,
      progress: parse(o.wa_progress) || {}, error: o.wa_error, error_code: o.wa_error_code,
      message: o.wa_message, message_source: o.wa_message_source,
      phone: ph && ph.ok ? ph.display : o.wa_phone, parts_sent: o.wa_parts_sent || 0,
      screenshots: shots ? shots.n : 0, sent_at: o.wa_sent_at, attempts: o.wa_attempts || 0,
      running: running.has(o.id), session: sender.status(),
    };
  }

  // On boot: nothing can still be running. Never auto-resend — mark failed so a person decides.
  async function recoverInterrupted() {
    await dbRun(`UPDATE orders SET wa_status='failed', workflow_state='WHATSAPP_FAILED', wa_error_code='interrupted',
        wa_error='Server restart hua jab WhatsApp shuru ho raha tha — Retry WhatsApp dabayein' WHERE wa_status='pending'`);
    await dbRun(`UPDATE orders SET wa_status='failed', workflow_state='WHATSAPP_FAILED', wa_error_code='interrupted_sending',
        wa_error='Server bhejte waqt band ho gaya — Retry se pehle customer ki WhatsApp chat check karein, message shayad chala gaya ho'
      WHERE wa_status IN ('processing','opening')`);
  }

  return { STEPS, processWhatsAppForOrder, retry, markSent, getStatus, recoverInterrupted, standardMessage };
};
