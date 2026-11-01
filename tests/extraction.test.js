// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const ai = require('../ai-import');
const rapidocrReal = require('../rapidocr-provider');
const { createExtractionService, createMerger, fiveFieldSummary } = require('../extraction-jobs');

const IMG = { mime: 'image/png', base64: 'AAAA', bytes: 3 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const abortable = (ms, signal, value) => new Promise((res, rej) => {
  const t = setTimeout(() => res(value), ms);
  signal && signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('cancelled'); e.code = 'aborted'; rej(e); }, { once: true });
});
// same trimming the server applies
const finalize = d => { d.client = { name: d.client.name, phones: d.client.phones, phone_unreadable: d.client.phone_unreadable, address: d.client.address };
  d.order = { tracking_id: d.order.tracking_id, cod_amount: d.order.cod_amount, lines: d.order.lines, product_name: d.order.product_name };
  d.stats = Object.assign({}, d.stats); return d; };

function service({ ocr, gemini, geminiOn = true }) {
  return createExtractionService({
    ai, rapidocr: { runRapidOcr: ocr }, geminiAvailable: () => geminiOn,
    callGemini: gemini, finalizeDraft: finalize, log: () => {},
  });
}
async function waitFinal(svc, owner, id, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const j = svc.manager.get(owner, id); if (j && j.state !== 'running') return j; await sleep(20); }
  throw new Error('job did not finish');
}
const ocrOut = (raw, text = '') => async () => ({ text, raw, filled: Object.values(raw).filter(Boolean).length, timingMs: null });
const gemOut = raw => async () => ({ data: raw });
const R = o => Object.assign({ client_name: null, phone_number: null, other_phones: [], tracking_id: null, cod_amount: null, address: null, product_name: null, unclear_fields: [] }, o);
const val = (d, k) => (k === 'phone' ? (d.client.phones[0] || {}).value : k === 'name' ? d.client.name.value : d.order[k] && d.order[k].value);

test('1. RapidOCR extracts all five → all five present', async () => {
  const svc = service({ ocr: ocrOut(R({ client_name: 'Ahmed Khan', phone_number: '03001234567', tracking_id: 'LP123456', cod_amount: '2500', product_name: 'Face Serum' }), 'Name: Ahmed Khan 0300 1234567 LP123456 COD 2500 Face Serum'),
    gemini: gemOut(R({ client_name: 'Ahmed Khan', phone_number: '03001234567', tracking_id: 'LP123456', cod_amount: 2500, product_name: 'Face Serum' })) });
  svc.start('u1', 'job-aaaaaaaa1', [IMG]);
  const j = await waitFinal(svc, 'u1', 'job-aaaaaaaa1');
  assert.equal(j.draft.stats.five.filled, 5);
  assert.deepEqual(j.draft.stats.five.missing, []);
});

test('2/3. RapidOCR partial, Gemini fills the rest (spec example)', async () => {
  const svc = service({
    ocr: ocrOut(R({ client_name: 'Ahmed', phone_number: '03001234567', product_name: 'Face Serum' }), 'Ahmed 03001234567 Face Serum'),
    gemini: gemOut(R({ client_name: 'Ahmed', cod_amount: 2500, product_name: 'Face Serum', tracking_id: 'LP123456' })) });
  svc.start('u1', 'job-aaaaaaaa2', [IMG]);
  const j = await waitFinal(svc, 'u1', 'job-aaaaaaaa2');
  const d = j.draft;
  assert.equal(val(d, 'name'), 'Ahmed'); assert.equal(val(d, 'phone'), '0300-1234567');
  assert.equal(val(d, 'cod_amount'), 2500); assert.equal(val(d, 'product_name'), 'Face Serum'); assert.equal(val(d, 'tracking_id'), 'LP123456');
  assert.equal(d.stats.five.filled, 5);
});

test('partial result is published after RapidOCR, BEFORE Gemini finishes', async () => {
  const svc = service({
    ocr: ocrOut(R({ client_name: 'Ahmed', phone_number: '03001234567' }), 'Ahmed 03001234567'),
    gemini: async (o, l, signal) => abortable(800, signal, { data: R({ client_name: 'Ahmed', tracking_id: 'LP123456' }) }) });
  svc.start('u1', 'job-aaaaaaaa3', [IMG]);
  await sleep(150);
  const mid = svc.manager.get('u1', 'job-aaaaaaaa3');
  assert.equal(mid.state, 'running'); assert.equal(mid.stage, 'gemini');
  assert.equal(mid.draft.stats.five.filled, 2);               // name + phone visible while Gemini still runs
  const j = await waitFinal(svc, 'u1', 'job-aaaaaaaa3');
  assert.equal(j.draft.stats.five.filled, 3);
});

test('4. RapidOCR fails, Gemini succeeds', async () => {
  const svc = service({ ocr: async () => { const e = new Error('down'); e.code = 'unavailable'; throw e; },
    gemini: gemOut(R({ client_name: 'Sara', phone_number: '03111234567', cod_amount: 1800, tracking_id: 'AB998877', product_name: 'Cream' })) });
  svc.start('u1', 'job-aaaaaaaa4', [IMG]);
  const j = await waitFinal(svc, 'u1', 'job-aaaaaaaa4');
  assert.equal(j.draft.stats.five.filled, 5); assert.match(j.notes.rapidocr, /failed/);
});

test('5. Gemini fails → RapidOCR result is kept', async () => {
  const svc = service({ ocr: ocrOut(R({ client_name: 'Ahmed', phone_number: '03001234567' }), 'Ahmed 03001234567'),
    gemini: async () => { const e = new Error('quota'); e.code = 'rate_limited'; throw e; } });
  svc.start('u1', 'job-aaaaaaaa5', [IMG]);
  const j = await waitFinal(svc, 'u1', 'job-aaaaaaaa5');
  assert.equal(j.state, 'done'); assert.equal(val(j.draft, 'name'), 'Ahmed'); assert.equal(j.draft.stats.five.filled, 2);
  assert.deepEqual(j.draft.stats.five.missing.sort(), ['price', 'product', 'tracking']);
});

test('6. Both fail → empty draft, job still completes (manual entry)', async () => {
  const svc = service({ ocr: async () => { const e = new Error('down'); e.code = 'unavailable'; throw e; },
    gemini: async () => { const e = new Error('boom'); e.code = 'upstream'; throw e; } });
  svc.start('u1', 'job-aaaaaaaa6', [IMG]);
  const j = await waitFinal(svc, 'u1', 'job-aaaaaaaa6');
  assert.equal(j.state, 'done'); assert.equal(j.draft.stats.five.filled, 0);
});

test('only ONE field available is still returned', async () => {
  const svc = service({ ocr: ocrOut(R({ tracking_id: 'LP123456' }), 'LP123456'), gemini: gemOut(R({})) });
  svc.start('u1', 'job-aaaaaaaa7', [IMG]);
  const j = await waitFinal(svc, 'u1', 'job-aaaaaaaa7');
  assert.equal(val(j.draft, 'tracking_id'), 'LP123456'); assert.equal(j.draft.stats.five.filled, 1);
});

test('disagreement that cannot be verified → field left BLANK + warning', async () => {
  const svc = service({ ocr: ocrOut(R({ cod_amount: '2500' }), 'COD 2500'), gemini: gemOut(R({ cod_amount: 3900 })) });
  svc.start('u1', 'job-aaaaaaaa8', [IMG]);
  const j = await waitFinal(svc, 'u1', 'job-aaaaaaaa8');
  assert.equal(val(j.draft, 'cod_amount'), null);
  assert.ok(j.draft.warnings.some(w => w.code === 'engine_conflict' && /Price/.test(w.message)));
});

test('disagreement where Gemini value IS on the page → Gemini wins (classification)', async () => {
  const svc = service({ ocr: ocrOut(R({ cod_amount: '150' }), 'Shipping 150 COD Total 2500'), gemini: gemOut(R({ cod_amount: 2500 })) });
  svc.start('u1', 'job-aaaaaaaa9', [IMG]);
  const j = await waitFinal(svc, 'u1', 'job-aaaaaaaa9');
  assert.equal(val(j.draft, 'cod_amount'), 2500);
});

test('hard limit: job finishes by the deadline with partial data', async () => {
  process.env.EXTRACT_HARD_LIMIT_MS = '400';
  delete require.cache[require.resolve('../extraction-jobs')];
  const { createExtractionService: mk } = require('../extraction-jobs');
  const svc = mk({ ai, rapidocr: { runRapidOcr: ocrOut(R({ client_name: 'Ahmed' }), 'Ahmed') }, geminiAvailable: () => true,
    callGemini: async (o, l, signal) => abortable(10000, signal, { data: R({}) }), finalizeDraft: finalize, log: () => {} });
  const t0 = Date.now();
  svc.start('u1', 'job-aaaaaa10', [IMG]);
  const j = await waitFinal(svc, 'u1', 'job-aaaaaa10', 3000);
  assert.ok(Date.now() - t0 < 1500); assert.equal(j.state, 'done'); assert.equal(j.timedOut, true);
  assert.equal(val(j.draft, 'name'), 'Ahmed');
  delete process.env.EXTRACT_HARD_LIMIT_MS; delete require.cache[require.resolve('../extraction-jobs')];
});

test('Gemini window: slow Gemini is cut off, RapidOCR data kept', async () => {
  process.env.GEMINI_WINDOW_MS = '200';
  delete require.cache[require.resolve('../extraction-jobs')];
  const { createExtractionService: mk } = require('../extraction-jobs');
  const svc = mk({ ai, rapidocr: { runRapidOcr: ocrOut(R({ client_name: 'Ahmed' }), 'Ahmed') }, geminiAvailable: () => true,
    callGemini: async (o, l, signal) => abortable(10000, signal, { data: R({}) }), finalizeDraft: finalize, log: () => {} });
  svc.start('u1', 'job-aaaaaa11', [IMG]);
  const j = await waitFinal(svc, 'u1', 'job-aaaaaa11', 3000);
  assert.equal(j.state, 'done'); assert.match(j.notes.gemini, /timeout/); assert.equal(val(j.draft, 'name'), 'Ahmed');
  delete process.env.GEMINI_WINDOW_MS; delete require.cache[require.resolve('../extraction-jobs')];
});

// ── cancellation ──
test('C1. cancel aborts the in-flight RapidOCR AND Gemini requests', async () => {
  let ocrAborted = false, gemAborted = false;
  const svc = service({
    ocr: async (img, { signal }) => { try { return await abortable(5000, signal, { text: '', raw: R({}), filled: 0 }); } catch (e) { ocrAborted = true; throw e; } },
    gemini: async (o, l, signal) => { try { return await abortable(5000, signal, { data: R({}) }); } catch (e) { gemAborted = true; throw e; } } });
  svc.start('u1', 'job-aaaaaa12', [IMG]);
  await sleep(50);
  svc.manager.cancel('u1', 'job-aaaaaa12');
  await sleep(50);
  assert.equal(ocrAborted, true);
  const j = svc.manager.get('u1', 'job-aaaaaa12');
  assert.equal(j.state, 'cancelled');
  // Gemini must never even start once cancelled during OCR
  assert.equal(gemAborted, false);
});

test('C2. cancel during Gemini aborts Gemini; late results never reach the job', async () => {
  let gemAborted = false;
  const svc = service({ ocr: ocrOut(R({ client_name: 'Ahmed' }), 'Ahmed'),
    gemini: async (o, l, signal) => { try { return await abortable(300, signal, { data: R({ client_name: 'Late' }) }); } catch (e) { gemAborted = true; throw e; } } });
  svc.start('u1', 'job-aaaaaa13', [IMG]);
  await sleep(100);
  svc.manager.cancel('u1', 'job-aaaaaa13');
  await sleep(500);
  const j = svc.manager.get('u1', 'job-aaaaaa13');
  assert.equal(gemAborted, true); assert.equal(j.state, 'cancelled'); assert.equal(j.draft, null);
  assert.equal(svc.manager.snapshot(j).draft, undefined);        // browser never sees data from a cancelled job
});

test('C3. old job cannot overwrite the next job (fresh job per screenshot)', async () => {
  let n = 0;
  const svc = service({ ocr: async () => { const my = ++n; await sleep(my === 1 ? 200 : 10); return { text: '', raw: R({ client_name: my === 1 ? 'OLD' : 'NEW' }), filled: 1 }; },
    gemini: gemOut(R({})) });
  svc.start('u1', 'job-aaaaaa14', [IMG]);
  svc.manager.cancel('u1', 'job-aaaaaa14', 'superseded');
  svc.start('u1', 'job-aaaaaa15', [IMG]);
  await sleep(400);
  const oldJ = svc.manager.get('u1', 'job-aaaaaa14'), newJ = await waitFinal(svc, 'u1', 'job-aaaaaa15');
  assert.equal(oldJ.state, 'cancelled'); assert.equal(oldJ.draft, null);
  assert.equal(val(newJ.draft, 'name'), 'NEW');
});

test('C4. cancel that arrives BEFORE the job exists is remembered (tombstone)', async () => {
  const svc = service({ ocr: ocrOut(R({}), ''), gemini: gemOut(R({})) });
  svc.manager.cancel('u1', 'job-aaaaaa16');
  assert.equal(svc.manager.wasCancelled('u1', 'job-aaaaaa16'), true);   // /api/ai/extract + /api/clients/save both check this
});

test('C5. jobs are private to their owner', async () => {
  const svc = service({ ocr: ocrOut(R({ client_name: 'A' }), 'A'), gemini: gemOut(R({})) });
  svc.start('u1', 'job-aaaaaa17', [IMG]);
  assert.equal(svc.manager.get('u2', 'job-aaaaaa17'), null);
});

test('RapidOCR regex: price / product / name labels', () => {
  const r = rapidocrReal.guessParcelFields('Customer Name: Ali Raza\nPhone 0312 3456789\nProduct: Hair Oil\nOrder Price: Rs. 2,800\nTracking ID: LP12345678');
  assert.equal(r.client_name, 'Ali Raza'); assert.equal(r.product_name, 'Hair Oil'); assert.equal(r.cod_amount, '2,800'); assert.equal(r.tracking_id, 'LP12345678');
});
