// MA CRM WhatsApp — runs in the CRM tab.
// Tells the extension the CRM is open, and lets it open a WhatsApp Web tab
// in THIS browser when an order is waiting and no WhatsApp tab is open.
(() => {
  if (window.__macrmCrm) return;
  window.__macrmCrm = true;
  document.documentElement.dataset.macrmWhatsapp = chrome.runtime.getManifest().version;
  document.documentElement.dataset.macrmOpenChat = '1';   // capability flag: this version can reuse the open WhatsApp tab

  // CRM page → extension: "open this customer's chat in the WhatsApp Web tab that is already open".
  // The reply tells the page whether a tab was reused or (only if none was open) created.
  window.addEventListener('message', ev => {
    const d = ev.data;
    if (ev.source !== window || !d || d.macrm !== 'open-chat-req' || typeof d.id !== 'string' || typeof d.url !== 'string') return;
    const reply = r => window.postMessage({ macrm: 'open-chat-res', id: d.id, ok: !!(r && r.ok), mode: r && r.mode, error: r && r.error }, window.location.origin);
    try {
      chrome.runtime.sendMessage({ type: 'open-chat', url: d.url }, r => {
        if (chrome.runtime.lastError) { console.warn('[MA CRM WhatsApp]', chrome.runtime.lastError.message); reply({ ok: false, error: chrome.runtime.lastError.message }); }
        else reply(r);
      });
    } catch (e) { reply({ ok: false, error: 'extension was reloaded — refresh this tab' }); }
  });
  const tick = () => {
    try {
      chrome.runtime.sendMessage({ type: 'crm-poll' }, r => {
        if (chrome.runtime.lastError) console.warn('[MA CRM WhatsApp]', chrome.runtime.lastError.message);
        else if (r && r.error) console.warn('[MA CRM WhatsApp] CRM poll:', r.error);
      });
    } catch (e) {
      console.warn('[MA CRM WhatsApp] extension was reloaded — refresh this tab', e);
      clearInterval(timer);
    }
  };
  const timer = setInterval(tick, 2000);
  tick();
})();
