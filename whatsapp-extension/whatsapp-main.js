// MA CRM WhatsApp — PAGE-WORLD helper (runs inside WhatsApp Web's own JavaScript world).
// Why: whatsapp.js runs in the extension's isolated world. WhatsApp's own code (React) often
// ignores paste / drop events whose files were created in that other world. This tiny script
// builds the files and fires the events from the page's own world, exactly like a user's paste.
// It only reacts to messages from whatsapp.js in this same tab and never touches the network.
(() => {
  if (window.__macrmMain) return;
  window.__macrmMain = true;

  const q = s => Array.from(document.querySelectorAll(s));
  const visible = el => !!el && el.isConnected && el.getClientRects().length > 0;
  const COMPOSE = 'footer div[contenteditable="true"], div[contenteditable="true"][data-tab="10"]';

  const toDataTransfer = items => {
    const dt = new DataTransfer();
    items.forEach(f => dt.items.add(new File([f.buf], f.name || 'order-screenshot.png', { type: f.type || 'image/png' })));
    return dt;
  };
  const caretToEnd = el => {
    el.focus();
    const sel = window.getSelection(), range = document.createRange();
    range.selectNodeContents(el); range.collapse(false);
    sel.removeAllRanges(); sel.addRange(range);
  };

  const methods = {
    paste(items) {
      const box = q(COMPOSE).find(visible);
      if (!box) throw new Error('chat box nahi mila');
      caretToEnd(box);
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: toDataTransfer(items), bubbles: true, cancelable: true }));
    },
    drop(items) {
      const box = q(COMPOSE).find(visible);
      const zone = document.querySelector('#main') || (box && box.closest('div[role="application"]')) || document.body;
      const dt = toDataTransfer(items);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        zone.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    },
    input(items) {
      const inputs = q('input[type="file"]');
      const input = inputs.find(i => /image/.test(i.accept || '')) || inputs[0];
      if (!input) throw new Error('file input nahi mila');
      input.files = toDataTransfer(items).files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    ping() {},
  };

  window.addEventListener('message', ev => {
    const d = ev.data;
    if (ev.source !== window || !d || d.macrm !== 'attach-req' || typeof d.id !== 'string') return;
    let ok = true, err = null;
    try {
      if (!methods[d.method]) throw new Error('unknown method');
      methods[d.method](Array.isArray(d.files) ? d.files : []);
    } catch (e) { ok = false; err = String((e && e.message) || e).slice(0, 120); }
    window.postMessage({ macrm: 'attach-res', id: d.id, ok, err }, '*');
  });
})();
