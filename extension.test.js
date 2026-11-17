// Run: node --test tests/extension.test.js   (mocks the Chrome extension APIs)
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const EXT = path.join(__dirname, '..', 'whatsapp-extension');

function loadBackground(waTabs) {
  const calls = { update: [], create: [], focus: [] };
  let listener;
  const chrome = {
    runtime: { getManifest: () => ({ version: '1.1.0' }), onMessage: { addListener: fn => { listener = fn; } } },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    tabs: {
      query: async q => (q.url === 'https://web.whatsapp.com/*' ? waTabs : []),
      update: async (id, p) => { calls.update.push([id, p]); },
      create: async p => { calls.create.push(p); return { id: 99 }; },
    },
    windows: { update: async (id, p) => { calls.focus.push([id, p]); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), { chrome, console, fetch: async () => ({}), URL, btoa: () => '', Uint8Array });
  const send = (msg, tab) => new Promise(res => listener(msg, { tab }, res));
  return { send, calls };
}
const URL_OK = 'https://web.whatsapp.com/send?phone=923001234567&text=Hello%20Ahmed%0ATracking%20LP1';
const CRM_TAB = { id: 1, windowId: 10, url: 'https://crm.example.com/' };

test('existing WhatsApp tab is REUSED — no new tab created', async () => {
  const { send, calls } = loadBackground([{ id: 5, windowId: 10 }]);
  const r = await send({ type: 'open-chat', url: URL_OK }, CRM_TAB);
  assert.deepEqual([r.ok, r.mode], [true, 'reused']);
  assert.equal(calls.create.length, 0); assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0][0], 5); assert.equal(calls.update[0][1].active, true);
  const u = new URL(calls.update[0][1].url);
  assert.equal(u.searchParams.get('phone'), '923001234567'); assert.match(u.searchParams.get('text'), /Tracking LP1/);
});

test('several WhatsApp tabs: prefers the one in the CRM window, still creates nothing', async () => {
  const { send, calls } = loadBackground([{ id: 7, windowId: 20 }, { id: 8, windowId: 10 }, { id: 9, windowId: 10 }]);
  await send({ type: 'open-chat', url: URL_OK }, CRM_TAB);
  assert.equal(calls.update[0][0], 8); assert.equal(calls.create.length, 0);
});

test('no WhatsApp tab open → falls back to opening one (in the CRM window)', async () => {
  const { send, calls } = loadBackground([]);
  const r = await send({ type: 'open-chat', url: URL_OK }, CRM_TAB);
  assert.deepEqual([r.ok, r.mode], [true, 'created']);
  assert.equal(calls.create.length, 1); assert.equal(calls.create[0].windowId, 10); assert.equal(calls.update.length, 0);
});

test('repeated Open Chat clicks never accumulate tabs', async () => {
  const { send, calls } = loadBackground([{ id: 5, windowId: 10 }]);
  for (let i = 0; i < 5; i++) await send({ type: 'open-chat', url: URL_OK }, CRM_TAB);
  assert.equal(calls.create.length, 0); assert.equal(calls.update.length, 5);
});

test('rejects anything that is not a WhatsApp click-to-chat link', async () => {
  const { send, calls } = loadBackground([{ id: 5, windowId: 10 }]);
  for (const bad of ['https://evil.example.com/send?phone=923001234567', 'https://web.whatsapp.com/other?phone=923001234567',
    'https://web.whatsapp.com/send?phone=abc', 'javascript:alert(1)', 'https://web.whatsapp.com.evil.com/send?phone=923001234567', '']) {
    const r = await send({ type: 'open-chat', url: bad }, CRM_TAB);
    assert.equal(r.ok, false, bad);
  }
  assert.equal(calls.update.length + calls.create.length, 0);
});

test('crm.js bridge: page request → extension → page reply; capability flag set', async () => {
  const listeners = {}; const posted = []; const sent = [];
  const win = { __macrmCrm: false, location: { origin: 'https://crm.example.com' },
    addEventListener: (t, fn) => { listeners[t] = fn; }, postMessage: (m, o) => posted.push([m, o]) };
  const doc = { documentElement: { dataset: {} } };
  const chrome = { runtime: { getManifest: () => ({ version: '1.1.0' }), lastError: null,
    sendMessage: (m, cb) => { sent.push(m); if (cb) cb(m.type === 'open-chat' ? { ok: true, mode: 'reused' } : {}); } } };
  vm.runInNewContext(fs.readFileSync(path.join(EXT, 'crm.js'), 'utf8'), { window: win, document: doc, chrome, console, setInterval: () => 1, clearInterval: () => {} });
  assert.equal(doc.documentElement.dataset.macrmOpenChat, '1');
  listeners.message({ source: win, data: { macrm: 'open-chat-req', id: 'abc', url: URL_OK } });
  assert.equal(sent.find(m => m.type === 'open-chat').url, URL_OK);
  const reply = posted.find(([m]) => m.macrm === 'open-chat-res');
  assert.deepEqual([reply[0].id, reply[0].ok, reply[0].mode, reply[1]], ['abc', true, 'reused', 'https://crm.example.com']);
  // messages from other frames / other shapes are ignored
  const before = sent.length;
  listeners.message({ source: {}, data: { macrm: 'open-chat-req', id: 'x', url: URL_OK } });
  listeners.message({ source: win, data: { macrm: 'something-else' } });
  assert.equal(sent.length, before);
});
