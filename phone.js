// ════════════════════════════════════════════════════════════
//  MA CRM — Phone number utility (WhatsApp)
//  One file used by BOTH the server (require('./phone')) and the
//  browser (<script src="/lib/phone.js"> → window.MAPhone), so the
//  review form and the server always agree on what is valid.
//
//  normalize('0300-1234567')      → { ok:true, number:'923001234567', display:'+92 300 1234567' }
//  normalize('+92 (0)300 1234567') → same
//  normalize('042-35761234')      → { ok:false, reason:'…landline…' }
//
//  Rule: if a number cannot be made safe it is REJECTED.
//  We never guess, and never message a wrongly formatted number.
// ════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MAPhone = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PK = '92';
  const PK_MOBILE = /^3\d{9}$/;            // 3XX XXXXXXX — every Pakistani mobile network

  function toWesternDigits(s) {
    return s
      .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))   // Arabic-Indic
      .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0));  // Urdu / Persian
  }

  function pkDisplay(rest) { return `+92 ${rest.slice(0, 3)} ${rest.slice(3)}`; }
  const okPk = rest => ({ ok: true, number: PK + rest, display: pkDisplay(rest), country: PK });

  /**
   * @param {string} input raw text typed by the user or read from a screenshot
   * @returns {{ok:true, number:string, display:string, country:string} | {ok:false, reason:string}}
   *          number = digits only, with country code, no "+" (what WhatsApp expects)
   */
  function normalize(input) {
    const raw = toWesternDigits(String(input == null ? '' : input)).trim();
    if (!raw) return { ok: false, reason: 'Phone number khali hai' };
    if (/[a-z]/i.test(raw.replace(/\b(ext|x)\b.*$/i, ''))) return { ok: false, reason: `"${raw}" mein letters hain — sirf number likhein` };

    const explicitIntl = /^\s*(\+|00)/.test(raw);
    let digits = raw.replace(/\D/g, '');
    if (raw.trim().startsWith('00')) digits = digits.replace(/^00/, '');

    // ── Pakistan, written with a country code: +92 300…, 0092 300…, 92 300…, +92 (0)300…
    if (digits.startsWith(PK) && (explicitIntl || digits.length >= 12)) {
      let rest = digits.slice(2);
      if (rest.startsWith('0')) rest = rest.slice(1);          // "+92 0300…" → drop the extra 0
      if (PK_MOBILE.test(rest)) return okPk(rest);
      if (explicitIntl || digits.length >= 12) {
        return { ok: false, reason: `"${raw}" Pakistani mobile number nahi lagta (+92 3XX XXXXXXX hona chahiye)` };
      }
    }

    // ── Other countries: only when written with + or 00, so we never guess a country
    if (explicitIntl) {
      if (digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0')) {
        return { ok: true, number: digits, display: '+' + digits, country: null };
      }
      return { ok: false, reason: `"${raw}" international number ki length sahi nahi` };
    }

    // ── Pakistan, local format
    if (digits.length === 11 && digits.startsWith('03')) return okPk(digits.slice(1));   // 03001234567
    if (digits.length === 10 && digits.startsWith('3'))  return okPk(digits);            // 3001234567

    if (digits.startsWith('0') && digits.length >= 9 && digits.length <= 11) {
      return { ok: false, reason: `"${raw}" landline number lagta hai — WhatsApp ke liye mobile number (03XX…) chahiye` };
    }
    return { ok: false, reason: `"${raw}" sahi mobile number nahi (03XX-XXXXXXX likhein)` };
  }

  /** "0300-1234567 / 0321 7654321" → ["0300-1234567", "0321 7654321"] */
  function split(text) {
    return String(text == null ? '' : text)
      .split(/[,;|\/\n]+|\s+or\s+|\s+ya\s+/i)
      .map(s => s.trim())
      .filter(Boolean);
  }

  /** First number in the list that normalizes cleanly. */
  function pickWhatsApp(list) {
    const items = Array.isArray(list) ? list : split(list);
    let firstError = null;
    for (const item of items) {
      const r = normalize(item);
      if (r.ok) return Object.assign({ source: item }, r);
      if (!firstError) firstError = r;
    }
    return firstError || { ok: false, reason: 'Koi phone number nahi mila' };
  }

  /** Same person/number, written differently? */
  function sameNumber(a, b) {
    const x = normalize(a), y = normalize(b);
    return x.ok && y.ok && x.number === y.number;
  }

  return { normalize, split, pickWhatsApp, sameNumber };
});
