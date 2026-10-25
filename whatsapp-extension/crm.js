// MA CRM WhatsApp — runs in the CRM tab.
// Tells the extension the CRM is open, and lets it open a WhatsApp Web tab
// in THIS browser when an order is waiting and no WhatsApp tab is open.
(() => {
  if (window.__macrmCrm) return;
  window.__macrmCrm = true;
  document.documentElement.dataset.macrmWhatsapp = chrome.runtime.getManifest().version;
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
