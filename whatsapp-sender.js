// ════════════════════════════════════════════════════════════
//  MA CRM — WhatsApp sender: SAME-BROWSER BRIDGE
//
//  The CRM never launches a browser. Sending is done by the
//  "MA CRM WhatsApp" browser extension inside the browser you
//  already use (Chrome or Edge), in the WhatsApp Web tab that is
//  already logged in there. Same browser, same session, no QR.
//
//      Your browser
//      ├── CRM tab ............ crm.js asks: "is a send waiting?"
//      └── WhatsApp Web tab ... whatsapp.js opens the chat, attaches
//                               the original screenshot, sends
//
//  Why an extension: a web page (the CRM) is not allowed by the
//  browser to control another tab. An extension is the only thing
//  that can act inside your existing, logged-in WhatsApp Web tab.
//  (Chrome 136+ also blocks remote-debugging connections to your
//  normal profile, so "connect to the running Chrome" is not possible.)
//
//  This module knows nothing about orders or the database.
//  Nothing in here can touch, roll back or delete an order.
// ════════════════════════════════════════════════════════════
const fs     = require('fs');
const crypto = require('crypto');

const WAIT_FOR_TAB_MS  = 45000;    // job not picked up by a WhatsApp tab → fail
const STEP_TIMEOUT_MS  = 120000;   // no progress report for this long → fail
const SEEN_MS          = 6000;     // a tab/extension counts as connected if seen within this

const S = { waTabSeen: 0, waTabId: null, loggedIn: null, extSeen: 0, version: null, since: Date.now() };
let job = null;
let queue = Promise.resolve();     // one send at a time — one WhatsApp Web tab

function waError(code, message, extra) { return Object.assign(new Error(message), { code }, extra || {}); }

function status() {
  const now = Date.now();
  const tab = now - S.waTabSeen < SEEN_MS;
  const ext = tab || now - S.extSeen < SEEN_MS;
  const state = !ext ? 'no_extension' : !tab ? 'no_tab' : S.loggedIn ? 'ready' : 'not_logged_in';
  return { installed: true, mode: 'browser', state, extension: S.version,
           lastSeen: Math.max(S.waTabSeen, S.extSeen) || null, me: null, error: null, busy: !!job, since: S.since };
}

function stateError() {
  const st = status().state;
  if (st === 'no_extension') return waError('no_extension', 'CRM WhatsApp extension is browser mein connected nahi (extension install / CRM tab open hai?)');
  if (st === 'no_tab')       return waError('no_tab', 'Is browser mein WhatsApp Web tab nahi mila / khul nahi saka');
  if (st === 'not_logged_in') return waError('not_linked', 'Is browser ke WhatsApp Web tab mein login nahi hai');
  return waError('timeout', 'WhatsApp Web tab ne jawab nahi diya');
}

// ── job lifecycle ───────────────────────────────────────────
function finish(err, result) {
  const j = job;
  if (!j) return;
  clearInterval(j.timer);
  job = null;
  if (err) j.reject(err); else j.resolve(result);
}

function createJob(spec) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    job = {
      id: crypto.randomBytes(8).toString('hex'),
      type: spec.type, number: spec.number, caption: spec.caption || '', files: spec.files || [],
      startAt: spec.startAt || 0, onStep: spec.onStep || (async () => {}), onPartSent: spec.onPartSent || (async () => {}),
      step: null, state: null, tabId: null, created: now, updated: now, resolve, reject,
    };
    const j = job;
    j.timer = setInterval(() => {
      if (job !== j) return clearInterval(j.timer);
      const t = Date.now();
      if (!j.step && t - j.created > WAIT_FOR_TAB_MS) {
        const e = stateError();
        Promise.resolve(j.onStep('open', 'failed')).catch(x => console.error('[WhatsApp] progress:', x.message));
        finish(Object.assign(e, { step: 'open' }));
      } else if (j.step && t - j.updated > STEP_TIMEOUT_MS) {
        const code = j.step === 'send' ? 'send_failed' : (j.step === 'attach' ? 'attach_failed' : 'timeout');
        Promise.resolve(j.onStep(j.step, 'failed')).catch(x => console.error('[WhatsApp] progress:', x.message));
        finish(waError(code, `WhatsApp tab ne "${j.step}" step par 2 minute tak jawab nahi diya${j.step === 'send' ? ' — chat check karein, message shayad chala gaya ho' : ''}`, { step: j.step }));
      }
    }, 2000);
  });
}

/**
 * Send the ORIGINAL screenshot file(s) + caption to one number, through the
 * WhatsApp Web tab of the user's own browser. Same signature as before.
 */
function sendOrder({ number, files, caption, startAt = 0, onStep = async () => {}, onPartSent = async () => {} }) {
  const run = queue.then(async () => {
    if (!files || !files.length) throw Object.assign(waError('attach_failed', 'Order ke saath koi screenshot save nahi hai'), { step: 'attach' });
    const remaining = files.slice(startAt);
    for (const [i, f] of remaining.entries()) {   // exact original, unchanged since upload
      try {
        if (f.sha256 && crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex') !== f.sha256) {
          throw new Error('file badal gayi hai (original se match nahi)');
        }
      } catch (e) {
        await onStep('attach', 'failed');
        throw waError('attach_failed', `Screenshot ${startAt + i + 1}: ${e.code === 'ENOENT' ? 'file nahi mili' : e.message}`, { step: 'attach' });
      }
    }
    await onStep('open', 'running');
    return createJob({
      type: 'order', number, files: remaining, startAt,
      caption: startAt > 0 ? '' : caption,           // caption already went with the first part
      onStep, onPartSent: async i => onPartSent(startAt + i),
    });
  });
  queue = run.catch(() => { /* returned to the caller */ });
  return run;
}

// Text-only test message — proves the CRM can drive WhatsApp Web in this browser.
function sendTest(number) {
  const run = queue.then(() => createJob({
    type: 'text', number,
    caption: `MA CRM test ✓ — CRM is browser ke WhatsApp Web se message bhej sakta hai (${new Date().toLocaleString('en-PK')})`,
  }));
  queue = run.catch(() => { /* returned to the caller */ });
  return run;
}

// Plain text message to one number (used by the VPL 3-day reminder).
// Separate from sendOrder / sendTest — order confirmations are untouched.
function sendText(number, text) {
  const run = queue.then(() => createJob({ type: 'text', number, caption: String(text || '') }));
  queue = run.catch(() => { /* returned to the caller */ });
  return run;
}

// ── endpoints used by the extension ─────────────────────────
// WhatsApp Web tab, every ~1.5 s
function poll({ tabId, loggedIn, version }) {
  Object.assign(S, { waTabSeen: Date.now(), waTabId: tabId, loggedIn: !!loggedIn, version: version || S.version });
  if (!job || (job.tabId && job.tabId !== tabId)) return null;
  return { id: job.id, type: job.type, number: job.number, caption: job.caption,
           fileCount: job.files.length, step: job.step, state: job.state };
}

// CRM tab, every ~2 s: tells the extension to open a WhatsApp Web tab (same browser) if a send waits and none is open
function crmPoll({ version }) {
  Object.assign(S, { extSeen: Date.now(), version: version || S.version });
  return { needWhatsAppTab: !!job && !job.step && Date.now() - S.waTabSeen > 4000 };
}

async function report({ jobId, tabId, step, state, code, message }) {
  if (!job || job.id !== jobId) return { ok: false, message: 'Job ab active nahi' };
  if (job.tabId && job.tabId !== tabId) return { ok: false, message: 'Job doosre WhatsApp tab ke paas hai' };
  if (!['open', 'chat', 'attach', 'send'].includes(step) || !['running', 'done', 'failed'].includes(state)) {
    return { ok: false, message: 'Bad report' };
  }
  const j = job;
  Object.assign(j, { tabId, step, state, updated: Date.now() });
  console.log(`[WhatsApp] tab ${tabId}: ${step} ${state}${code ? ' (' + code + ')' : ''}${message ? ' — ' + message : ''}`);
  try { await j.onStep(step, state); }
  catch (e) { console.error('[WhatsApp] progress save failed:', e.message); }
  if (state === 'failed') {
    finish(waError(code || 'error', message || `WhatsApp "${step}" step fail hua`, { step }));
  } else if (step === 'send' && state === 'done') {
    for (let i = 0; i < j.files.length; i++) {
      try { await j.onPartSent(i); } catch (e) { console.error('[WhatsApp] part save failed:', e.message); }
    }
    finish(null, { tabId });
  }
  return { ok: true };
}

function fileFor({ jobId, index, tabId }) {
  if (!job || job.id !== jobId || (job.tabId && job.tabId !== tabId)) return null;
  return job.files[index] || null;
}

// Kept for the existing routes / UI — there is nothing to start or log out any more.
async function start()  { return status(); }
async function logout() { return status(); }

module.exports = { start, logout, status, sendOrder, sendTest, sendText, poll, crmPoll, report, fileFor, isInstalled: () => true };
