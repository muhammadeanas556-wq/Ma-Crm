// ════════════════════════════════════════════════════════════
//  MA CRM — RapidOCR provider adapter (Priority 1 OCR engine)
//
//  Calls the external RapidOCR FastAPI service's template-free
//  /extract-text-generic endpoint, then runs a small regex pass
//  over the returned OCR text to guess the same raw field names
//  Gemini/NVIDIA return (client_name, phone_number, tracking_id,
//  cod_amount, address, other_phones, unclear_fields).
//
//  IMPORTANT: this module does NOT replace or change the CRM's
//  field-extraction/validation/mapping logic. The raw guess built
//  here is handed to ai.validateParcel() in server.js, exactly like
//  a Gemini/NVIDIA answer — the same aliases, sanitizing, phone
//  normalization, dedup and confidence rules in ai-import.js run
//  on it unchanged.
// ════════════════════════════════════════════════════════════

const RAPIDOCR_BASE_URL = (process.env.RAPIDOCR_BASE_URL || 'http://127.0.0.1:8000').trim().replace(/\/+$/, '');
// RapidOCR is tried FIRST, before Gemini. The target is ~4 seconds; this is the hard cut-off
// for the OCR call (default 6 s). If it hasn't answered by then the pipeline moves on to Gemini
// instead of waiting any longer. The whole job (OCR + Gemini) is additionally capped at 60 s
// by extraction-jobs.js.
const RAPIDOCR_TIMEOUT_MS = Number(process.env.RAPIDOCR_TIMEOUT_MS) || 60000;   // TESTING: 60 s (same as Gemini)
const RAPIDOCR_ENABLED = String(process.env.RAPIDOCR_ENABLED || '1').trim() !== '0';

// Cache /health for a few seconds so a down/slow service doesn't add a health
// round-trip on every screenshot in a multi-image import.
let healthCache = { ok: false, at: 0 };
const HEALTH_TTL_MS = 10000;

async function withTimeout(promiseFactory, ms, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onExternalAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onExternalAbort);
  try {
    return await promiseFactory(ctrl.signal);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

async function checkHealth(signal) {
  const now = Date.now();
  if (now - healthCache.at < HEALTH_TTL_MS) return healthCache.ok;
  let ok = false;
  try {
    const res = await withTimeout(
      s => fetch(`${RAPIDOCR_BASE_URL}/health`, { method: 'GET', signal: s }),
      Math.min(RAPIDOCR_TIMEOUT_MS, 1500),
      signal
    );
    ok = !!(res && res.ok);
  } catch (e) {
    ok = false;
  }
  healthCache = { ok, at: now };
  return ok;
}

// ── OCR CALL ─────────────────────────────────────────────────
// image: { mime, base64 } (same shape ai.decodeImage already produces).
async function extractGenericText(image, signal) {
  const buf = Buffer.from(image.base64, 'base64');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: image.mime }), 'screenshot.' + (image.mime.split('/')[1] || 'png'));

  const res = await withTimeout(
    s => fetch(`${RAPIDOCR_BASE_URL}/extract-text-generic`, { method: 'POST', body: form, signal: s }),
    RAPIDOCR_TIMEOUT_MS,
    signal
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`RapidOCR HTTP ${res.status}`);
    err.code = 'rapidocr_http';
    err.detail = String(detail || '').slice(0, 200);
    throw err;
  }
  const json = await res.json();
  return { text: String(json && json.text || ''), timingMs: json && json.timing_ms || null };
}

// ── FIELD GUESSING FROM PLAIN OCR TEXT ──────────────────────
// Mirrors the shape callGemini()/callNvidia() hand to ai.validateParcel() —
// it does NOT reimplement validateParcel's own cleanup/aliasing, which still
// runs afterwards in ai-import.js unchanged.
const PHONE_RE = /(?<!\d)(?:\+?92[\s-]?3\d{2}|03\d{2}|3\d{2})[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g;
const COD_LABEL_RE = /(?:COD(?:\s*AMOUNT)?|CASH ON DELIVERY|COLLECT AMOUNT|ORDER\s*(?:PRICE|AMOUNT|TOTAL)|TOTAL(?:\s*(?:AMOUNT|PRICE))?|PRICE|AMOUNT)\s*[:#\-]?\s*(?:RS\.?|PKR)?\s*([\d][\d,]*)/i;
const BARE_AMOUNT_RE = /(?:RS\.?|PKR)\s*([\d,]{2,})/i;
// Require: a real label word, THEN an explicit "No"/"Number"/"ID"/"#" qualifier or a
// colon/dash separator (not just whitespace — bare "Shipment" next to other printed
// text, e.g. branding like "COD Retail Shipment", must not match), AND the captured
// value must contain at least one digit (a plain word like "AWBNo" bleeding in from a
// neighboring label, as happened on a real slip, is all letters and gets rejected).
const TRACKING_LABEL_RE = /(?:AWB|TRACKING|CONSIGNMENT|CN)\s*(?:NO\.?|NUMBER|ID|#)?\s*[:#\-]\s*([A-Z0-9][A-Z0-9\-]{3,24}\d)(?=\s|$)/i;
const NAME_LABEL_RE = /\b(?:CUSTOMER(?:\s*NAME)?|NAME|RECEIVER(?:\s*NAME)?|CONSIGNEE(?:\s*NAME)?|TO)\s*[:#\-]\s*([A-Za-z][A-Za-z .]{2,40})/i;
const PRODUCT_LABEL_RE = /\b(?:PRODUCT(?:\s*NAME)?|ITEM(?:\s*NAME)?|DESCRIPTION|SKU|ITEM\s*DESC(?:RIPTION)?)\s*[:#\-]\s*([^\n]{2,60})/i;

// The five fields the CRM needs: name, phone, price, product, tracking. This is a
// deliberately small, fast regex pass, not a full-document read. Anything a pattern doesn't
// confidently match is left null — Gemini (step 2) then fills/verifies it from the image,
// and whatever is still missing stays blank for the user to complete.
function guessParcelFields(text) {
  const raw = { client_name: null, phone_number: null, other_phones: [], tracking_id: null, cod_amount: null, product_name: null };
  if (!text) return raw;

  const phones = [...new Set((text.match(PHONE_RE) || []).map(p => p.trim()))];
  if (phones.length) {
    raw.phone_number = phones[0];
    raw.other_phones = phones.slice(1, 5);
  }

  const codMatch = text.match(COD_LABEL_RE) || text.match(BARE_AMOUNT_RE);
  if (codMatch) raw.cod_amount = codMatch[1];

  // A courier slip often prints the AWB/tracking number twice (once on a sticker
  // overlapping other text, once cleanly in the printed body) — OCR frequently
  // mangles the sticker occurrence by merging it with neighboring text. Instead of
  // taking the first match, collect every candidate and keep the longest: a merged/
  // truncated misread is reliably shorter than the real value.
  const trkCandidates = [...text.matchAll(new RegExp(TRACKING_LABEL_RE, 'gi'))].map(m => m[1]);
  if (trkCandidates.length) {
    raw.tracking_id = trkCandidates.reduce((best, c) => (c.length > best.length ? c : best));
  }

  const nameMatch = text.match(NAME_LABEL_RE);
  if (nameMatch) raw.client_name = nameMatch[1].trim();

  const productMatch = text.match(PRODUCT_LABEL_RE);
  if (productMatch) raw.product_name = productMatch[1].trim();

  return raw;
}

// How many of the 4 required fields a guess actually filled — used to decide whether
// RapidOCR's result is "sufficient" or whether to fall back to the existing
// Gemini/NVIDIA provider (avoids a confident-looking but near-empty draft winning
// over a provider that could have read the screenshot properly).
function filledCount(raw) {
  let n = 0;
  if (raw.client_name) n++;
  if (raw.phone_number) n++;
  if (raw.tracking_id) n++;
  if (raw.cod_amount) n++;
  if (raw.product_name) n++;
  return n;
}

// ── PUBLIC ENTRY POINT ───────────────────────────────────────
// runRapidOcr(): returns { text, raw, filled, timingMs } — ALWAYS including the OCR text and
// whatever the regex pass found, even when it found very little (that text is handed to
// Gemini as a hint, and a partial result must never be thrown away).
// Throws only when RapidOCR could not be used at all: disabled / unavailable / HTTP error /
// timeout / cancelled (err.code = disabled | unavailable | rapidocr_http | aborted | timeout).
async function runRapidOcr(image, { signal = null } = {}) {
  if (!RAPIDOCR_ENABLED) {
    const e = new Error('RapidOCR disabled (RAPIDOCR_ENABLED=0)');
    e.code = 'disabled';
    throw e;
  }
  const healthy = await checkHealth(signal);
  if (signal && signal.aborted) { const e = new Error('cancelled'); e.code = 'aborted'; throw e; }
  if (!healthy) {
    const e = new Error('RapidOCR service unavailable (/health failed)');
    e.code = 'unavailable';
    throw e;
  }
  let out;
  try {
    out = await extractGenericText(image, signal);
  } catch (err) {
    if (signal && signal.aborted) { const e = new Error('cancelled'); e.code = 'aborted'; throw e; }
    if (err && err.name === 'AbortError') { const e = new Error(`RapidOCR did not answer within ${RAPIDOCR_TIMEOUT_MS / 1000}s`); e.code = 'timeout'; throw e; }
    throw err;
  }
  const raw = guessParcelFields(out.text);
  return { text: out.text, raw, filled: filledCount(raw), timingMs: out.timingMs, variant: 'rapidocr' };
}

// Kept for backward compatibility with older callers.
async function tryRapidOcr(image, { signal = null, minFilled = 3 } = {}) {
  const r = await runRapidOcr(image, { signal });
  if (r.filled < minFilled) {
    const e = new Error(`RapidOCR read too little (${r.filled} field(s))`);
    e.code = 'insufficient';
    e.raw = r.raw;
    throw e;
  }
  return { data: r.raw, variant: 'rapidocr', timingMs: r.timingMs, filled: r.filled };
}

module.exports = {
  RAPIDOCR_BASE_URL, RAPIDOCR_ENABLED, RAPIDOCR_TIMEOUT_MS,
  checkHealth, extractGenericText, guessParcelFields, filledCount, runRapidOcr, tryRapidOcr,
};
