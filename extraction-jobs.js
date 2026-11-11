// ════════════════════════════════════════════════════════════
//  MA CRM — extraction-jobs.js
//  Screenshot extraction as a cancellable JOB:
//
//    Step 1  RapidOCR  (target ~4 s)   → partial result is published immediately
//    Step 2  Gemini    (gets the image + RapidOCR's text as a hint)
//            → field-level merge with RapidOCR's result
//    Hard cap: 120 s for the whole job (60 s RapidOCR + 60 s Gemini) (EXTRACT_HARD_LIMIT_MS)
//
//  Rules implemented here
//   • Never reject an incomplete screenshot: whatever was read is returned, the rest stays blank.
//   • Never invent values. If RapidOCR and Gemini disagree and neither reading can be verified
//     (see resolveScalar), the field is left BLANK and reported in `engineConflicts`.
//   • Cancellation: every job owns an AbortController that is passed to RapidOCR and Gemini
//     fetches and their retry sleeps. After cancel(), the pipeline cannot publish anything.
//   • Nothing in this file touches the database. A job can never create an order.
// ════════════════════════════════════════════════════════════
const crypto = require('crypto');

const HARD_LIMIT_MS   = Number(process.env.EXTRACT_HARD_LIMIT_MS) || 120000;   // whole job
const GEMINI_WINDOW_MS = Number(process.env.GEMINI_WINDOW_MS) || 60000;       // Gemini's share
const KEEP_FINISHED_MS = 5 * 60 * 1000;                                       // result kept for polling
const TOMBSTONE_MS     = 10 * 60 * 1000;                                      // "this id was cancelled"
const JOB_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ── small helpers ───────────────────────────────────────────
const has = f => !!f && f.value !== null && f.value !== undefined && f.value !== '';
const alnum = v => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
const words = v => String(v == null ? '' : v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const tokens = v => words(v).split(' ').filter(Boolean);

function numbersIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = parseFloat(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}
function phoneKeysIn(text, phoneKey) {
  const out = new Set();
  // any 10–13 digit run, allowing the usual separators between digit groups
  for (const m of String(text || '').matchAll(/(?<!\d)(?:\+?\d[\s-]?){9,13}\d(?!\d)/g)) {
    const k = phoneKey(m[0]);
    if (k) out.add(k);
  }
  return out;
}

// ── FIELD-LEVEL MERGE (RapidOCR result × Gemini result) ─────
// Both inputs are ai.validateParcel() outputs (or null when that engine gave nothing).
// Returns the same shape, plus `engineConflicts: [{field,label,ocr,gemini}]`.
//
//   agree                         → keep it, confidence "high"
//   only one engine has a value   → keep it (never discard a partial result)
//   both have different values    → a value is "verified" when it can be found in the OCR text
//     · Gemini's value found in the OCR text  → it picked the right token on the page → Gemini wins
//     · exactly one value passes the strict format check → that one wins
//     · otherwise                              → neither can be verified → field left BLANK
function createMerger(ai) {
  const SAME = {
    cod_amount: (a, b) => Number(a) === Number(b),
    tracking_id: (a, b) => alnum(a) === alnum(b),
    client_name: (a, b) => compatibleText(a, b),
    product_name: (a, b) => compatibleText(a, b),
    address: (a, b) => compatibleText(a, b),
  };
  // "Ahmed" vs "Ahmed Khan", case/spacing differences → same value
  function compatibleText(a, b) {
    const ta = tokens(a), tb = tokens(b);
    if (!ta.length || !tb.length) return false;
    if (ta.join(' ') === tb.join(' ')) return true;
    const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    return small.every(t => big.includes(t));
  }
  const SUPPORTED = {
    cod_amount: (v, text) => numbersIn(text).has(Number(v)),
    tracking_id: (v, text) => alnum(text).includes(alnum(v)),
    client_name: (v, text) => { const tt = new Set(tokens(text)); const tv = tokens(v); return tv.length > 0 && tv.every(t => tt.has(t)); },
    product_name: (v, text) => { const tt = words(text); const tv = tokens(v); return tv.length > 0 && tv.every(t => tt.includes(t)); },
    address: (v, text) => { const tt = new Set(tokens(text)); const tv = tokens(v); return tv.length > 0 && tv.filter(t => tt.has(t)).length / tv.length >= 0.7; },
  };
  const VALID = {
    cod_amount: v => Number(v) > 0 && Number(v) < 1e7,
    tracking_id: v => { const t = alnum(v); return t.length >= 6 && /\d/.test(t); },
    client_name: v => tokens(v).length >= 1,
    product_name: v => tokens(v).length >= 1,
    address: v => tokens(v).length >= 2,
  };
  const LABEL = { client_name: 'Customer Name', phone: 'Phone Number', cod_amount: 'Price', product_name: 'Product', tracking_id: 'Tracking ID', address: 'Address' };

  function resolveScalar(key, a, b, text, conflicts) {
    const empty = { value: null, confidence: null, evidence: null };
    if (!has(a) && !has(b)) return { ...empty, evidence: (b && b.evidence) || (a && a.evidence) || null };
    if (has(a) && !has(b)) return { ...a, confidence: a.confidence === 'high' ? 'medium' : a.confidence, engine: 'rapidocr' };   // single source → worth a look
    if (!has(a) && has(b)) return { ...b, engine: 'gemini' };
    if (SAME[key](a.value, b.value)) {
      // keep Gemini's formatting (fuller name, spacing) — both engines agree, so confidence is high
      const keepOcr = key === 'client_name' && tokens(a.value).length > tokens(b.value).length;
      return { ...(keepOcr ? a : b), confidence: 'high', engine: 'both' };
    }
    // disagreement
    if (SUPPORTED[key](b.value, text)) return { ...b, confidence: 'medium', engine: 'gemini' };
    const aOk = VALID[key](a.value), bOk = VALID[key](b.value);
    if (aOk && !bOk) return { ...a, confidence: 'low', engine: 'rapidocr' };
    if (bOk && !aOk) return { ...b, confidence: 'low', engine: 'gemini' };
    conflicts.push({ field: key, label: LABEL[key], ocr: a.value, gemini: b.value });
    return { value: null, confidence: null, evidence: `RapidOCR: "${String(a.value).slice(0, 40)}" / Gemini: "${String(b.value).slice(0, 40)}" — not verified`, engine: 'conflict' };
  }

  function resolvePhones(A, B, text, conflicts, unreadable) {
    if (!B.length) return A.map(p => ({ ...p, engine: 'rapidocr', confidence: p.confidence === 'high' ? 'medium' : p.confidence }));
    if (!A.length) return B.map(p => ({ ...p, engine: 'gemini' }));
    if (A[0].key === B[0].key) return B.map((p, i) => ({ ...p, engine: i === 0 ? 'both' : 'gemini', confidence: i === 0 ? 'high' : p.confidence }));
    if (phoneKeysIn(text, ai.phoneKey).has(B[0].key)) return B.map(p => ({ ...p, engine: 'gemini', confidence: p.confidence === 'high' ? 'medium' : p.confidence }));
    const aOk = A[0].confidence !== 'low', bOk = B[0].confidence !== 'low';
    if (aOk && !bOk) return [{ ...A[0], engine: 'rapidocr', confidence: 'low' }];
    if (bOk && !aOk) return B.map(p => ({ ...p, engine: 'gemini' }));
    conflicts.push({ field: 'phone', label: LABEL.phone, ocr: A[0].value, gemini: B[0].value });
    return [];
  }

  // ocrV / gemV: validateParcel() outputs or null
  function mergeEngines(ocrV, gemV, ocrText) {
    const conflicts = [];
    if (ocrV && !gemV) return tag(ocrV, 'rapidocr', conflicts);
    if (gemV && !ocrV) return tag(gemV, 'gemini', conflicts);
    if (!ocrV && !gemV) return null;
    const text = String(ocrText || '');
    const out = {
      client_name:  resolveScalar('client_name', ocrV.client_name, gemV.client_name, text, conflicts),
      tracking_id:  resolveScalar('tracking_id', ocrV.tracking_id, gemV.tracking_id, text, conflicts),
      cod_amount:   resolveScalar('cod_amount', ocrV.cod_amount, gemV.cod_amount, text, conflicts),
      address:      resolveScalar('address', ocrV.address, gemV.address, text, conflicts),
      product_name: resolveScalar('product_name', ocrV.product_name, gemV.product_name, text, conflicts),
      phones:       resolvePhones(ocrV.phones || [], gemV.phones || [], text, conflicts),
      phone_unreadable: null,
    };
    if (!out.phones.length && !conflicts.some(c => c.field === 'phone')) out.phone_unreadable = gemV.phone_unreadable || ocrV.phone_unreadable || null;
    out.engineConflicts = conflicts;
    return out;
  }
  function tag(v, engine, conflicts) {
    const mark = f => (has(f) ? { ...f, engine, confidence: engine === 'rapidocr' && f.confidence === 'high' ? 'medium' : f.confidence } : f);
    return {
      ...v,
      client_name: mark(v.client_name), tracking_id: mark(v.tracking_id), cod_amount: mark(v.cod_amount),
      address: mark(v.address), product_name: mark(v.product_name),
      phones: (v.phones || []).map(p => ({ ...p, engine, confidence: engine === 'rapidocr' && p.confidence === 'high' ? 'medium' : p.confidence })),
      engineConflicts: conflicts,
    };
  }
  return { mergeEngines, LABEL };
}

// ── THE FIVE FIELDS (used for the "complete the missing fields" notice) ──
function fiveFieldSummary(draft) {
  const c = (draft && draft.client) || {}, o = (draft && draft.order) || {};
  const f = x => has(x);
  const lines = Array.isArray(o.lines) ? o.lines : [];
  const present = {
    name: f(c.name),
    phone: Array.isArray(c.phones) && c.phones.length > 0,
    price: f(o.cod_amount),
    product: f(o.product_name) || lines.length > 0,
    tracking: f(o.tracking_id),
  };
  const missing = Object.keys(present).filter(k => !present[k]);
  return { present, missing, filled: 5 - missing.length };
}

// ── JOB MANAGER ─────────────────────────────────────────────
function createJobManager() {
  const jobs = new Map();         // `${owner}:${id}` → job
  const tombstones = new Map();   // `${owner}:${id}` → timestamp (cancelled before / without a job)
  const key = (owner, id) => `${owner}:${id}`;

  function newId() { return crypto.randomBytes(12).toString('hex'); }
  function validId(id) { return typeof id === 'string' && JOB_ID_RE.test(id); }

  function active(owner) { for (const j of jobs.values()) if (j.owner === owner && j.state === 'running') return j; return null; }
  function get(owner, id) { return jobs.get(key(owner, id)) || null; }
  function wasCancelled(owner, id) {
    const j = get(owner, id);
    return !!(j && j.state === 'cancelled') || tombstones.has(key(owner, id));
  }

  function create(owner, id) {
    const j = {
      id, owner, state: 'running', stage: 'ocr', rev: 0, startedAt: Date.now(), endedAt: null,
      ctrl: new AbortController(), cancelReason: null, timedOut: false,
      draft: null, notes: {}, error: null, deadlineTimer: null,
    };
    j.deadlineTimer = setTimeout(() => { if (j.state === 'running') { j.timedOut = true; j.cancelReason = 'deadline'; j.ctrl.abort(); } }, HARD_LIMIT_MS);
    if (j.deadlineTimer.unref) j.deadlineTimer.unref();
    jobs.set(key(owner, id), j);
    return j;
  }

  // reason: 'user' | 'superseded'. Marks the job cancelled and aborts every in-flight request.
  function cancel(owner, id, reason = 'user') {
    const j = get(owner, id);
    if (!j) { tombstones.set(key(owner, id), Date.now()); return { found: false }; }   // cancel arrived before the job existed
    if (j.state === 'running') {
      j.state = 'cancelled'; j.cancelReason = reason; j.endedAt = Date.now();
      j.rev++; j.draft = null;                       // nothing from a cancelled job may reach the UI
      clearTimeout(j.deadlineTimer);
      try { j.ctrl.abort(); } catch (e) { /* already aborted */ }
    }
    tombstones.set(key(owner, id), Date.now());
    return { found: true, state: j.state };
  }

  function finish(j, state, patch = {}) {
    if (j.state !== 'running') return false;      // already cancelled → ignore late results
    Object.assign(j, patch, { state, endedAt: Date.now() });
    j.rev++;
    clearTimeout(j.deadlineTimer);
    return true;
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, j] of jobs) if (j.endedAt && now - j.endedAt > KEEP_FINISHED_MS) jobs.delete(k);
    for (const [k, t] of tombstones) if (now - t > TOMBSTONE_MS) tombstones.delete(k);
  }, 60000);
  if (sweeper.unref) sweeper.unref();

  // What the browser may see. `sinceRev` lets an unchanged poll skip the draft.
  function snapshot(j, sinceRev) {
    const snap = {
      id: j.id, state: j.state, stage: j.stage, rev: j.rev, final: j.state !== 'running',
      elapsedMs: (j.endedAt || Date.now()) - j.startedAt, hardLimitMs: HARD_LIMIT_MS,
      timedOut: j.timedOut, notes: j.notes, error: j.error,
    };
    if (j.state !== 'cancelled' && (sinceRev === undefined || sinceRev !== j.rev)) snap.draft = j.draft;
    return snap;
  }

  return { newId, validId, active, get, create, cancel, finish, wasCancelled, snapshot, HARD_LIMIT_MS };
}

// ── PIPELINE ────────────────────────────────────────────────
// deps: { ai, rapidocr, callGemini(opts, log, signal), geminiAvailable(), finalizeDraft(draft), log }
function createExtractionService(deps) {
  const { ai, rapidocr, callGemini, geminiAvailable, finalizeDraft } = deps;
  const log = deps.log || (() => {});
  const { mergeEngines } = createMerger(ai);
  const manager = createJobManager();

  const sleep = (ms, signal) => new Promise(r => { const t = setTimeout(r, ms); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });

  // child signal: aborts on parent abort OR after `ms`
  function withWindow(parent, ms) {
    const c = new AbortController();
    const onAbort = () => c.abort();
    if (parent.aborted) c.abort(); else parent.addEventListener('abort', onAbort, { once: true });
    const t = setTimeout(() => c.abort(), ms);
    if (t.unref) t.unref();
    return { signal: c.signal, done: () => { clearTimeout(t); parent.removeEventListener('abort', onAbort); } };
  }

  function buildDraft(slots, total) {
    const results = slots.map((s, i) => {
      const data = s.final || s.ocr || null;
      return data
        ? { index: i + 1, ok: true, data, engineConflicts: (s.final && s.final.engineConflicts) || [] }
        : { index: i + 1, ok: false, error: s.error || 'not read yet', code: s.errorCode || 'pending' };
    });
    // A screenshot that has not been read yet is not an error worth a warning
    const drafted = ai.mergeParcels(results.filter(r => r.ok || r.code !== 'pending'));
    const draft = finalizeDraft(drafted);
    draft.stats = Object.assign({}, draft.stats, { screenshots: total, five: fiveFieldSummary(draft) });
    return draft;
  }

  async function processImage(job, slot, image, i, total) {
    const tag = `[extract ${job.id.slice(0, 6)}] screenshot ${i + 1}/${total}`;
    const publish = () => {
      if (job.state !== 'running') return;
      job.draft = buildDraft(job.slots, total);
      job.rev++;
    };

    // ── Step 1: RapidOCR ──
    const t0 = Date.now();
    let ocrText = '';
    try {
      const r = await deps.rapidocr.runRapidOcr(image, { signal: job.ctrl.signal });
      ocrText = r.text || '';
      slot.ocr = ai.validateParcel(r.raw);
      job.notes.rapidocr = `ok (${r.filled} field(s), ${Date.now() - t0}ms)`;
      log(`${tag} RapidOCR ok — ${r.filled} field(s) in ${Date.now() - t0}ms`);
    } catch (e) {
      if (job.state !== 'running' && job.cancelReason !== 'deadline') return;
      job.notes.rapidocr = `failed: ${e.code || 'error'}`;
      log(`${tag} RapidOCR unavailable (${e.code || 'error'}: ${e.message}) — going straight to Gemini`);
    }
    if (job.state !== 'running') return;
    job.stage = 'gemini';
    job.rev++;                                   // stage/notes changed -> make pollers re-read even if the draft is unchanged
    publish();                                   // ← usable partial result shown to the user right away

    // ── Step 2: Gemini (image + RapidOCR text) ──
    if (!geminiAvailable()) { job.notes.gemini = 'not configured'; slot.stage = 'done'; slot.final = slot.ocr ? mergeEngines(slot.ocr, null, ocrText) : null; publish(); return; }
    const g0 = Date.now();
    const win = withWindow(job.ctrl.signal, GEMINI_WINDOW_MS);
    try {
      const out = await callGemini({ image, index: i + 1, total, ocrText, onLog: m => log(`${tag} ${m}`) }, m => log(`${tag} ${m}`), win.signal);
      slot.gem = ai.validateParcel(out.data);
      job.notes.gemini = `ok (${Date.now() - g0}ms)`;
      log(`${tag} Gemini ok in ${Date.now() - g0}ms`);
    } catch (e) {
      if (job.state !== 'running' && job.cancelReason !== 'deadline') { win.done(); return; }
      const windowHit = win.signal.aborted && !job.ctrl.signal.aborted;
      job.notes.gemini = windowHit ? `timeout after ${GEMINI_WINDOW_MS / 1000}s` : `failed: ${e.code || 'error'}`;
      slot.errorCode = windowHit ? 'timeout' : (e.code || 'upstream');
      slot.error = e.message;
      if (e.code === 'config') job.error = { code: 'config', message: e.message };
      log(`${tag} Gemini ${windowHit ? 'timed out' : 'failed'} (${e.code || 'error'}: ${e.message}) — keeping RapidOCR result`);
    } finally { win.done(); }

    // Merge whatever exists. RapidOCR's result is never discarded when Gemini fails.
    slot.final = mergeEngines(slot.ocr, slot.gem, ocrText);
    slot.stage = 'done';
    if (job.state === 'running' || job.cancelReason === 'deadline') {
      // on the deadline abort the state is still 'running' (only user cancel flips it), so publish normally
      publish();
    }
  }

  // Starts the job in the background. Returns immediately.
  function start(owner, id, images) {
    const job = manager.create(owner, id);
    job.slots = images.map(() => ({ ocr: null, gem: null, final: null, stage: 'ocr', error: null, errorCode: null }));
    const total = images.length;

    (async () => {
      // two screenshots at a time, same as before
      let next = 0;
      const worker = async () => {
        while (next < images.length && job.state === 'running' && !job.ctrl.signal.aborted) {
          const i = next++;
          try { await processImage(job, job.slots[i], images[i], i, total); }
          catch (e) { log(`[extract ${job.id.slice(0, 6)}] screenshot ${i + 1} crashed: ${e && e.stack || e}`); job.slots[i].error = 'unexpected error'; job.slots[i].errorCode = 'upstream'; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, images.length) }, worker));

      if (job.state !== 'running') return;       // cancelled (user / superseded) — publish nothing
      // Whatever happened (incl. the hard-limit deadline), finish with the best draft we have.
      let draft = null;
      try { draft = buildDraft(job.slots, total); } catch (e) { log(`[extract ${job.id.slice(0, 6)}] draft build failed: ${e.message}`); }
      if (job.timedOut) job.notes.deadline = `stopped at ${HARD_LIMIT_MS / 1000}s hard limit`;
      manager.finish(job, 'done', { draft, stage: 'done' });
      log(`[extract ${job.id.slice(0, 6)}] done in ${((Date.now() - job.startedAt) / 1000).toFixed(1)}s — ${draft ? draft.stats.five.filled : 0}/5 fields`);
    })().catch(e => {
      log(`[extract ${job.id.slice(0, 6)}] failed: ${e && e.stack || e}`);
      manager.finish(job, 'done', { draft: null, error: { code: 'upstream', message: 'Unexpected server error while reading the screenshot.' } });
    });
    return job;
  }

  return { manager, start, mergeEngines, fiveFieldSummary };
}

module.exports = { createExtractionService, createJobManager, createMerger, fiveFieldSummary, HARD_LIMIT_MS, GEMINI_WINDOW_MS };
