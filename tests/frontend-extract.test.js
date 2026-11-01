// Runs the REAL extraction block of public/index.html in a sandbox with stubbed DOM + network.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const a = html.indexOf('// ── EXTRACT ───'), b = html.indexOf('const AI_ERROR_HINTS = {');
const cancelFnStart = html.indexOf('// Tell the server to cancel');
assert(a > 0 && b > a);
const block = html.slice(a, b);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function sandbox(handler) {
  const log = { steps: [], renders: [], fetches: [], cancels: [], toasts: [], manual: 0 };
  const el = () => ({ textContent: '', style: {}, value: '', classList: { toggle() {}, remove() {}, add() {} }, querySelector: () => ({ scrollTop: 0 }), insertAdjacentHTML() {}, focus() {} });
  const ctx = {
    console, setTimeout, clearTimeout, AbortController, Event: class {}, Promise,
    role: 'admin', API: '', AI_MAX_PAYLOAD: 9e6, CUSTOM_PRODUCT_VALUE: '__c',
    window: { crypto: undefined }, crypto: { randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2).padEnd(12, '0') },
    toast: m => log.toasts.push(m), esc: x => x,
    aiState: { images: [{ dataUrl: 'data:image/png;base64,AAAA', name: 'a.png' }], draft: null, busy: false, refining: false, jobId: null, saving: false, abort: null, step: 'upload', dirty: false },
    aiById: () => el(), aiShowStep: s => log.steps.push(s), aiUpdateUploadButtons() {}, aiShowError: (m, c) => log.steps.push('error:' + c),
    aiRenderReview: d => log.renders.push(d), aiVal: f => (f && f.value) || '', aiDraftLines: () => [], aiUpdateWaLine() {}, aiUpdateRemaining() {},
    document: { querySelector: () => null, querySelectorAll: () => [] },
    apiFetch: async (url, opts) => { log.fetches.push(url); if (opts && opts.signal && opts.signal.aborted) { const e = new Error('x'); e.name = 'AbortError'; throw e; } return handler(url, opts); },
    fetch: (url, opts) => { log.cancels.push(url); return Promise.resolve({}); },
  };
  vm.createContext(ctx);
  vm.runInContext(block + '\n' + html.slice(cancelFnStart, html.indexOf('const AI_ERROR_HINTS')), ctx);   // block already holds cancel fns
  return { ctx, log };
}
const draft = (n, fin) => ({ client: {}, order: {}, warnings: [], stats: { filled: n, five: { filled: n, missing: [] } } });

test('F1. RapidOCR partial shows immediately, Gemini final applied after', async () => {
  let polls = 0;
  const { ctx, log } = sandbox(url => {
    if (url === '/api/ai/extract') return { success: true, jobId: 'x' };
    polls++;
    return polls === 1 ? { success: true, job: { state: 'running', stage: 'gemini', final: false, rev: 1, draft: draft(3) } }
                       : { success: true, job: { state: 'done', stage: 'done', final: true, rev: 2, draft: draft(5) } };
  });
  ctx.aiApplyFinal = () => log.steps.push('applyFinal'); ctx.aiSetRefine = on => log.steps.push('refine:' + on); ctx.aiUpdateMissingNote = () => {};
  await ctx.aiExtract();
  assert.ok(log.steps.indexOf('review') > -1);
  assert.ok(log.steps.indexOf('applyFinal') > log.steps.indexOf('review'));
  assert.equal(ctx.aiState.busy, false);
});

test('F2. X during extraction: aborts fetches, POSTs cancel, stale poll response is ignored', async () => {
  const { ctx, log } = sandbox(async url => {
    if (url === '/api/ai/extract') return { success: true, jobId: 'x' };
    await sleep(80);                                                 // slow poll in flight when X is clicked
    return { success: true, job: { state: 'done', final: true, rev: 5, draft: draft(5) } };
  });
  ctx.aiSetRefine = () => {}; ctx.aiApplyFinal = () => { throw new Error('stale result applied!'); };
  const p = ctx.aiExtract();
  await sleep(30);
  const jobId = ctx.aiState.jobId;
  ctx.aiCancelExtract({ silent: true });                              // what the X button does
  await p; await sleep(120);
  assert.equal(log.cancels.length, 1); assert.match(log.cancels[0], new RegExp(`/api/ai/extract/${jobId}/cancel`));
  assert.equal(log.renders.length, 0);                                // old response never touched the UI
  assert.equal(ctx.aiState.jobId, null); assert.equal(ctx.aiState.busy, false);
});

test('F3. next screenshot starts a FRESH job id; old job response cannot update it', async () => {
  const seen = []; let first = true;
  const { ctx, log } = sandbox(async (url, opts) => {
    if (url === '/api/ai/extract') { const id = JSON.parse(opts.body).jobId; seen.push(id); return { success: true, jobId: id }; }
    if (first) { first = false; await sleep(60); return { success: true, job: { state: 'done', final: true, rev: 1, draft: draft(5) } }; }
    return { success: true, job: { state: 'done', final: true, rev: 1, draft: draft(2) } };
  });
  ctx.aiSetRefine = () => {}; ctx.aiApplyFinal = () => {}; ctx.aiUpdateMissingNote = () => {};
  const p1 = ctx.aiExtract(); await sleep(20);
  ctx.aiCancelExtract({ silent: true });
  await ctx.aiExtract(); await p1;
  assert.equal(seen.length, 2); assert.notEqual(seen[0], seen[1]);
  assert.equal(log.renders.length, 1); assert.equal(log.renders[0].stats.five.filled, 2);   // only the NEW job rendered
});

test('F4. nothing extracted / server error → empty manual form (never blocks Place Order)', async () => {
  const { ctx, log } = sandbox(url => url === '/api/ai/extract' ? { success: true, jobId: 'x' }
    : { success: true, job: { state: 'done', final: true, rev: 1, draft: draft(0), notes: { gemini: 'failed: network' } } });
  ctx.aiSetRefine = () => {};
  await ctx.aiExtract();
  assert.equal(log.renders.length, 1); assert.ok(log.steps.includes('review')); assert.ok(!log.steps.some(s => String(s).startsWith('error')));
});

test('F5. cancelled job state from server → UI does nothing', async () => {
  const { ctx, log } = sandbox(url => url === '/api/ai/extract' ? { success: true, jobId: 'x' } : { success: true, job: { state: 'cancelled', final: true, rev: 2 } });
  ctx.aiSetRefine = () => {};
  await ctx.aiExtract();
  assert.equal(log.renders.length, 0);
});
