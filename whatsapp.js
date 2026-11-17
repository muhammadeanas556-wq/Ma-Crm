// MA CRM WhatsApp — runs inside YOUR WhatsApp Web tab (already logged in).
// Picks up one order at a time from the CRM server and, in this same tab:
//   open customer chat → attach the ORIGINAL screenshot → caption → Send.
//
// If WhatsApp changes its page and something stops working, the CSS selectors
// are all in SEL below — that is the only place that should need an update.
(() => {
  if (window.__macrmWa) return;
  window.__macrmWa = true;

  const SEL = {
    app:     '#side, #pane-side, [aria-label="Chat list"], [data-testid="chat-list"]',
    qr:      'canvas[aria-label*="scan" i], [data-ref] canvas, [data-testid="qrcode"]',
    compose: 'footer div[contenteditable="true"], div[contenteditable="true"][data-tab="10"]',
    send:    '[data-icon="send"], [data-icon="wds-ic-send-filled"], [data-icon="send-light"], button[aria-label="Send"], div[aria-label="Send"], [aria-label="Send" i]',
    attach:  '[data-icon="plus"], [data-icon="plus-rounded"], [data-icon="attach-menu-plus"], [data-icon="clip"], [aria-label="Attach"], [title="Attach"]',
    dialog:  '[role="dialog"], [data-animate-modal-popup="true"]',
  };
  const NAV_KEY = 'macrm_nav_job';
  const TRIES_KEY = 'macrm_nav_tries';

  const log = (...a) => console.log('[MA CRM WhatsApp]', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const q = s => Array.from(document.querySelectorAll(s));
  const visible = el => !!el && el.isConnected && el.getClientRects().length > 0;
  const norm = t => String(t || '').replace(/\s+/g, ' ').trim();
  const fail = (code, message) => Object.assign(new Error(message), { code });

  const composeBox  = () => q(SEL.compose).find(visible) || null;
  const loggedIn    = () => q(SEL.app).some(visible) || !!composeBox();
  const qrShown     = () => q(SEL.qr).some(visible);
  const outsideMain = el => !el.closest('footer') && !el.closest('#side') && !el.closest('#pane-side');
  const previewSend = () => q(SEL.send).find(el => visible(el) && outsideMain(el)) || null;
  const footerSend  = () => q(SEL.send).find(el => visible(el) && el.closest('footer')) || null;
  const captionBox  = () => q('div[contenteditable="true"]').find(el => visible(el) && outsideMain(el)) || null;
  const invalidNumber = () => q(SEL.dialog).some(d => visible(d) && /invalid|not on whatsapp|isn.t on whatsapp/i.test(d.innerText || ''));

  async function waitFor(fn, ms, every = 250) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(every);
    }
    return null;
  }

  function msg(type, data) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type, ...data }, r => {
          if (chrome.runtime.lastError) { console.warn('[MA CRM WhatsApp]', type, chrome.runtime.lastError.message); resolve(null); }
          else resolve(r);
        });
      } catch (e) {
        console.warn('[MA CRM WhatsApp] extension was reloaded — refresh this WhatsApp tab', e);
        resolve(null);
      }
    });
  }

  async function report(job, step, state, code, message) {
    const r = await msg('wa-report', { jobId: job.id, step, state, code, message });
    if (!r || !r.ok) throw Object.assign(new Error((r && (r.message || r.error)) || 'CRM ne report accept nahi kiya'), { code: 'abandoned' });
  }

  function clickEl(el) {
    const target = el.closest('button, [role="button"]') || el;
    target.click();
  }

  function caretToEnd(el) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Insert text the way a user's paste would (keeps line breaks), with a typing fallback
  async function insertText(el, text) {
    caretToEnd(el);
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    const probe = norm(text).slice(0, 25);
    if (await waitFor(() => norm(el.innerText).includes(probe), 1500)) return;
    log('paste of text not taken — typing instead');
    caretToEnd(el);
    document.execCommand('insertText', false, text);
    if (!(await waitFor(() => norm(el.innerText).includes(probe), 1500))) {
      throw fail('send_failed', 'Message text WhatsApp ke box mein nahi dala ja saka');
    }
  }

  // Attach exact original files. Tries paste → drag&drop → the attach menu's file input.
  async function attachFiles(files) {
    const box = composeBox();
    const make = () => { const dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); return dt; };

    if (box) {
      caretToEnd(box);
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: make(), bubbles: true, cancelable: true }));
      if (await waitFor(previewSend, 6000)) return 'paste';
    }
    const zone = document.querySelector('#main') || box && box.closest('div[role="application"]') || document.body;
    const dt = make();
    for (const type of ['dragenter', 'dragover', 'drop']) {
      zone.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
    if (await waitFor(previewSend, 6000)) return 'drop';

    const btn = q(SEL.attach).find(visible);
    if (btn) { clickEl(btn); await sleep(900); }
    const inputs = q('input[type="file"]');
    const input = inputs.find(i => /image/.test(i.accept || '')) || inputs[0];
    if (input) {
      input.files = make().files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (await waitFor(previewSend, 8000)) return 'file-input';
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    throw fail('attach_failed', 'WhatsApp ne screenshot accept nahi kiya (paste, drag-drop aur attach — teeno try kiye)');
  }

  async function loadFiles(job) {
    const files = [];
    for (let i = 0; i < job.fileCount; i++) {
      const r = await msg('wa-file', { jobId: job.id, index: i });
      if (!r || !r.b64) throw fail('attach_failed', `Screenshot ${i + 1} CRM se nahi mila${r && r.error ? ': ' + r.error : ''}`);
      const bin = atob(r.b64);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      files.push(new File([bytes], r.name, { type: r.mime }));   // byte-for-byte the uploaded original
    }
    return files;
  }

  // ── after navigating to /send?phone=… : chat → attach → caption → send ──
  async function finishInChat(job) {
    const ready = await waitFor(() => (composeBox() && 'chat') || (invalidNumber() && 'invalid') || (qrShown() && 'qr'), 60000, 400);
    if (ready === 'qr')      { await report(job, 'open', 'failed', 'not_linked', 'Is browser ke WhatsApp Web mein login nahi hai'); return; }
    if (!ready)              { await report(job, 'open', 'failed', 'timeout', 'WhatsApp Web ki chat 60 second mein nahi khuli'); return; }
    await report(job, 'open', 'done');
    if (ready === 'invalid') { await report(job, 'chat', 'failed', 'not_on_whatsapp', `+${job.number} WhatsApp par nahi hai (WhatsApp: number invalid)`); return; }
    await report(job, 'chat', 'done');
    await sleep(600);

    if (job.type === 'text') {            // test message
      await report(job, 'send', 'running');
      await insertText(composeBox(), job.caption);
      const btn = await waitFor(footerSend, 4000);
      if (!btn) throw fail('send_failed', 'Send button nahi mila');
      clickEl(btn);
      if (!(await waitFor(() => { const b = composeBox(); return b && !norm(b.innerText); }, 10000))) throw fail('send_failed', 'Message send hua ya nahi — chat check karein');
      await report(job, 'send', 'done');
      return;
    }

    await report(job, 'attach', 'running');
    const files = await loadFiles(job);
    const how = await attachFiles(files);
    log(`attached ${files.length} original screenshot(s) via ${how}`);
    await report(job, 'attach', 'done');

    await report(job, 'send', 'running');
    const cap = job.caption ? await waitFor(captionBox, 4000) : null;
    if (job.caption && cap) await insertText(cap, job.caption);
    const sendBtn = previewSend();
    if (!sendBtn) throw fail('send_failed', 'Screenshot ke saath Send button nahi mila');
    clickEl(sendBtn);
    if (!(await waitFor(() => !previewSend(), 30000))) throw fail('send_failed', 'Screenshot send hua ya nahi — chat check karein');

    if (job.caption && !cap) {            // no caption box in this WhatsApp version → send text right after
      log('no caption box — sending the message as a separate text');
      await sleep(800);
      await insertText(await waitFor(composeBox, 5000), job.caption);
      const b = await waitFor(footerSend, 4000);
      if (!b) throw fail('send_failed', 'Screenshot chala gaya, lekin message ka Send button nahi mila — message khud bhejein');
      clickEl(b);
      await waitFor(() => { const c = composeBox(); return c && !norm(c.innerText); }, 10000);
    }
    await sleep(1200);
    await report(job, 'send', 'done');
  }

  let busy = false;
  async function runJob(job) {
    const navJob = sessionStorage.getItem(NAV_KEY);

    // A send was in the middle of attaching/sending when this page reloaded → never guess, report it.
    if (job.step === 'attach' || job.step === 'send') {
      await report(job, job.step, 'failed', job.step === 'send' ? 'send_failed' : 'attach_failed',
        'WhatsApp tab beech mein reload ho gaya — Retry se pehle customer ki chat check karein');
      return;
    }

    if (navJob === job.id) {               // we navigated this tab to the customer's chat — continue there
      sessionStorage.removeItem(NAV_KEY);
      try { await finishInChat(job); }
      finally { await msg('wa-restore'); }
      return;
    }

    // New job (or the chat page got lost): claim it, bring this tab to the front, open the customer's chat.
    const tries = Number(sessionStorage.getItem(TRIES_KEY + job.id) || 0);
    if (tries >= 3) { await report(job, 'open', 'failed', 'timeout', 'Customer chat 3 dafa try karke bhi nahi khuli'); return; }
    if (!loggedIn()) {
      const ok = await waitFor(loggedIn, 20000, 500);
      if (!ok) { await report(job, 'open', 'failed', 'not_linked', 'Is browser ke WhatsApp Web mein login nahi hai — pehle WhatsApp Web mein login karein'); return; }
    }
    await report(job, 'open', 'running');
    await msg('wa-activate');
    sessionStorage.setItem(TRIES_KEY + job.id, String(tries + 1));
    sessionStorage.setItem(NAV_KEY, job.id);
    log(`opening chat for +${job.number}`);
    location.href = 'https://web.whatsapp.com/send?phone=' + encodeURIComponent(job.number);
    await sleep(30000);                    // page is reloading
  }

  async function tick() {
    if (busy) return;
    busy = true;
    let job = null;
    try {
      const r = await msg('wa-poll', { loggedIn: loggedIn() });
      if (r && r.error) console.warn('[MA CRM WhatsApp] CRM poll:', r.error);
      job = r && r.job;
      if (job) await runJob(job);
    } catch (e) {
      console.error('[MA CRM WhatsApp] send failed:', e);
      if (job && e.code !== 'abandoned') {
        const step = /attach/.test(e.code) ? 'attach' : (e.code === 'send_failed' ? 'send' : 'open');
        await msg('wa-report', { jobId: job.id, step, state: 'failed', code: e.code || 'error', message: e.message });
        await msg('wa-restore');
      }
    } finally {
      busy = false;
    }
  }

  setInterval(tick, 1500);
  tick();
  log('ready in this WhatsApp Web tab');
})();
