// Runs the REAL success-screen code from public/index.html with several server states.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const a = html.indexOf('const WA_STEPS = ['), b = html.indexOf('async function waRetry') > 0 ? html.indexOf('async function waRetry') : html.indexOf('// ── CONNECT WHATSAPP');
const end = html.indexOf('\n// ═', a);
const code = html.slice(a, end > 0 ? end : undefined);
function render(st) {
  let out = '';
  const ctx = { esc: x => String(x), waView: {}, aiById: () => ({ set innerHTML(v) { out = v; } }) };
  vm.createContext(ctx); vm.runInContext(code.replace(/^async function waPoll[\s\S]*?^}/m, '').replace(/^function waApplyToRow[\s\S]*?^}/m, '') + '\nthis.waRenderProgress=waRenderProgress;', ctx);
  ctx.waRenderProgress(Object.assign({ order_id: 7, order_code: 'MA-1126-7', message: 'Hello Umar', message_source: 'template', phone: '+92 348 9364716', progress: {} }, st));
  return out;
}
const FORBIDDEN = ['WhatsApp Web opening', 'Customer chat opened', 'Original screenshot attached', 'Message sent', 'Retry WhatsApp', 'Connect WhatsApp', 'Not started', 'was not started', 'WhatsApp failed', 'extension'];
const states = {
  'new server (status null)': { status: null, progress: { message: 'done', phone: 'done' } },
  'OLD server automation failed (no_extension)': { status: 'failed', step: 'open', error_code: 'no_extension', error: 'extension not connected', progress: { message: 'done', phone: 'done', open: 'failed' } },
  'OLD server chat step failed': { status: 'failed', step: 'chat', error: 'x', progress: { message: 'done', phone: 'done' } },
  'OLD server still processing': { status: 'processing', progress: { message: 'done', phone: 'done', open: 'running' } },
};
for (const [name, st] of Object.entries(states)) test(`success screen — ${name}`, () => {
  const h = render(st);
  for (const f of FORBIDDEN) assert.ok(!h.includes(f), `must not contain "${f}"`);
  assert.equal((h.match(/<li class=/g) || []).length, 5);                       // exactly the five steps
  for (const l of ['Order information validated', 'Order saved', 'Order ID generated', 'WhatsApp message generated', 'Customer number checked']) assert.ok(h.includes(l));
  assert.ok(h.includes('Order placed successfully.')); assert.ok(h.includes('Hello Umar'));          // message preview
  assert.ok(h.includes('openDispatch(7)') && h.includes('Send Dispatch Message'));                   // original Dispatch button
  assert.ok(h.includes('aiRequestClose()'));                                                          // Close
  assert.equal((h.match(/class="ok"|class="done"/g) || []).length >= 5, true);
});
test('real failure of a REMAINING check is still reported (message generation)', () => {
  const h = render({ status: 'failed', step: 'message', error: 'template broken', progress: { message: 'failed' } });
  assert.ok(h.includes('message generation failed')); assert.ok(!h.includes('Retry WhatsApp')); assert.ok(h.includes('openDispatch(7)'));
});
