// MA CRM WhatsApp — background (service worker).
// Relays between the CRM server (localhost) and the WhatsApp Web tab of THIS browser.
// It never creates a window or a profile; at most it opens/focuses a TAB in the current window.
const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_CRM = 'http://localhost:3000';
let returnTo = null;   // tab to go back to after a send

async function crmBase() {
  const { crmBase } = await chrome.storage.local.get('crmBase');
  return crmBase || DEFAULT_CRM;
}

async function api(path, opts = {}) {
  const base = await crmBase();
  const { bridgeToken } = await chrome.storage.local.get('bridgeToken');
  const res = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(bridgeToken ? { 'X-MACRM-BRIDGE-TOKEN': bridgeToken } : {}), ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`CRM server ${res.status} for ${path}`);
  return res;
}
const post = async (path, body) => (await api(path, { method: 'POST', body: JSON.stringify(body) })).json();

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Dispatch → "Open Chat": the CRM asks for a customer's chat. Only a plain WhatsApp Web
// click-to-chat link is accepted (rebuilt from its parsed parts), so a compromised page cannot
// use this to open arbitrary sites.
function safeChatUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.origin !== 'https://web.whatsapp.com' || u.pathname !== '/send') return null;
    const phone = u.searchParams.get('phone') || '';
    const text = u.searchParams.get('text') || '';
    if (!/^\d{8,15}$/.test(phone) || text.length > 4000) return null;
    const out = new URL('https://web.whatsapp.com/send');
    out.searchParams.set('phone', phone);
    if (text) out.searchParams.set('text', text);
    return out.toString();
  } catch (e) { return null; }
}

async function handle(msg, sender) {
  const tab = sender.tab;
  switch (msg.type) {
    case 'open-chat': {
      const target = safeChatUrl(msg.url);
      if (!target) return { ok: false, error: 'invalid chat link' };
      const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
      if (tabs.length) {
        // Reuse the WhatsApp Web tab that is already open (prefer the one in the CRM's own window).
        // Same browser profile → the logged-in WhatsApp session is preserved. No new tab is created.
        const pick = tabs.find(t => tab && t.windowId === tab.windowId) || tabs[0];
        await chrome.tabs.update(pick.id, { url: target, active: true });
        await chrome.windows.update(pick.windowId, { focused: true }).catch(e => console.warn('[MA CRM WhatsApp] focus window:', e.message));
        return { ok: true, mode: 'reused', tabs: tabs.length };
      }
      await chrome.tabs.create({ url: target, active: true, windowId: tab ? tab.windowId : undefined });   // fallback: none open
      return { ok: true, mode: 'created' };
    }
    case 'crm-poll': {
      if (tab && tab.url) await chrome.storage.local.set({ crmBase: new URL(tab.url).origin });
      const r = await post('/api/wa-bridge/crm-poll', { version: VERSION });
      if (r.needWhatsAppTab) {
        const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
        if (!tabs.length) {
          console.log('[MA CRM WhatsApp] order waiting, no WhatsApp tab — opening one in this window');
          returnTo = tab ? { tabId: tab.id, windowId: tab.windowId } : null;
          await chrome.tabs.create({ url: 'https://web.whatsapp.com/', active: true, windowId: tab ? tab.windowId : undefined });
        } else if (tabs[0].discarded) {
          await chrome.tabs.reload(tabs[0].id);   // Chrome put it to sleep — wake it so it can pick up the order
        }
      }
      return r;
    }
    case 'wa-poll':
      return post('/api/wa-bridge/poll', { tabId: tab.id, loggedIn: !!msg.loggedIn, version: VERSION });
    case 'wa-report':
      return post(`/api/wa-bridge/jobs/${encodeURIComponent(msg.jobId)}/report`,
        { tabId: tab.id, step: msg.step, state: msg.state, code: msg.code, message: msg.message });
    case 'wa-file': {
      const res = await api(`/api/wa-bridge/jobs/${encodeURIComponent(msg.jobId)}/files/${msg.index}?tabId=${tab.id}`);
      const buf = await res.arrayBuffer();
      return { b64: toBase64(buf), mime: res.headers.get('Content-Type') || 'image/png',
               name: decodeURIComponent(res.headers.get('X-File-Name') || 'order-screenshot'), size: buf.byteLength };
    }
    case 'wa-activate': {
      // WhatsApp only renders in a visible tab, so bring it to the front during the send
      const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (active && active.id !== tab.id && !returnTo) returnTo = { tabId: active.id, windowId: active.windowId };
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true };
    }
    case 'wa-restore': {
      const back = returnTo; returnTo = null;
      if (back) await chrome.tabs.update(back.tabId, { active: true }).catch(e => console.warn('[MA CRM WhatsApp] return to CRM tab:', e.message));
      return { ok: true };
    }
    default:
      return { error: 'unknown message ' + msg.type };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, e => {
    console.warn('[MA CRM WhatsApp]', msg.type, 'failed:', e.message);
    reply({ error: e.message });
  });
  return true;   // async reply
});
