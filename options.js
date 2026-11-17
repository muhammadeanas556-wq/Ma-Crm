const urlEl = document.getElementById('url');
const tokenEl = document.getElementById('token');
const statusEl = document.getElementById('status');
chrome.storage.local.get(['crmBase','bridgeToken'], ({crmBase,bridgeToken}) => {
  urlEl.value = crmBase || 'http://localhost:3000';
  tokenEl.value = bridgeToken || '';
});
document.getElementById('save').addEventListener('click', async () => {
  try {
    const u = new URL(urlEl.value.trim());
    if (!['https:','http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || (u.protocol==='http:' && !['localhost','127.0.0.1'].includes(u.hostname))) throw new Error('Use HTTPS (or localhost HTTP).');
    const origin = u.origin;
    const token = tokenEl.value.trim();
    if (u.protocol === 'https:' && token.length < 32) throw new Error('For online use, enter a token with at least 32 characters.');
    await chrome.storage.local.set({crmBase:origin, bridgeToken:token});
    try { await chrome.scripting.unregisterContentScripts({ids:['macrm-online']}); } catch(e) {}
    if (u.protocol === 'https:') await chrome.scripting.registerContentScripts([{
      id:'macrm-online', matches:[origin+'/*'], js:['crm.js'], runAt:'document_idle', persistAcrossSessions:true
    }]);
    statusEl.textContent = 'Saved. Refresh your CRM and WhatsApp Web tabs.';
  } catch(e) { statusEl.textContent='Could not save: '+e.message; }
});