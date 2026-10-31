// ════════════════════════════════════════════════════════════
//  MA CRM — ai-providers.js
//  One adapter per AI vision provider. Every adapter returns the SAME
//  normalized shape, so ai-router.js (and server.js) never has to know
//  which provider answered:
//
//    { success, provider, model, data, confidence, processingTimeMs, error }
//
//  `data` is the raw parsed JSON the model returned (same parcel shape
//  Gemini already returns) — ai-import.js's validateParcel() cleans it
//  exactly the same way regardless of which provider produced it.
//
//  Gemini and NVIDIA already have adapters in ai-import.js (callGemini /
//  callNvidia) — this file wraps them into the same normalized shape and
//  adds: Groq, Mistral, LLM7.io, Z AI (Zhipu), Cloudflare Workers AI and
//  Kilo Code.
// ════════════════════════════════════════════════════════════
const ai = require('./ai-import');
const { AiError, LIMITS, parseModelJson, PARCEL_PROMPT } = ai;

const PARCEL_JSON_SHAPE = '{"client_name": null, "phone_number": null, "other_phones": [], "tracking_id": null, "cod_amount": null, "address": null, "unclear_fields": []}';
// Same prompt shape Gemini gets (ai-import.js keeps its own copy for its own request-variant
// logic) — kept identical here so every provider is judged on the same instructions.
function buildUserTextForProvider(index, total) {
  const head = total > 1 ? `Screenshot ${index} of ${total}.\n` : '';
  return `${head}${PARCEL_PROMPT}\n\nAnswer with exactly this JSON shape:\n${PARCEL_JSON_SHAPE}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function now() { return Date.now(); }

// Strips `provider.apiKey` out of any error text before it can reach a log or the browser.
function scrub(text, apiKey) {
  if (!apiKey) return text;
  return String(text || '').split(apiKey).join('***');
}

// ── Shared timeout/abort plumbing for a single fetch() call ───
async function fetchJson(url, options, { timeoutMs = LIMITS.TIMEOUT_MS, signal = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onExternalAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onExternalAbort);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    return { res, json, text };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

function httpErrorCode(status) {
  if (status === 401 || status === 403) return 'config';
  if (status === 404) return 'config';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream';
  if (status === 408) return 'timeout';
  return 'bad_request';
}

// ── GENERIC OpenAI-chat-completions-compatible adapter ────────
// Covers Groq, Mistral, LLM7.io, Z AI and Kilo Code: all of these expose
// an OpenAI-style POST {base}/chat/completions with a vision-capable
// model, image sent as a data: URI inside image_url content parts.
async function callOpenAICompatible({ id, label, baseUrl, apiKey, model, image, index, total, signal, extraHeaders = {}, timeoutMs }) {
  const started = now();
  if (!apiKey) throw new AiError('config', `${label}: API key is not set on the server`);
  if (!image || !image.base64 || !image.mime) throw new AiError('bad_image', 'Screenshot data is missing');

  const url = String(baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model,
    temperature: 0.1,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } },
        { type: 'text', text: buildUserTextForProvider(index, total) },
      ],
    }],
  };

  let res, json, text;
  try {
    ({ res, json, text } = await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...extraHeaders },
      body: JSON.stringify(body),
    }, { signal, timeoutMs }));
  } catch (e) {
    if (signal && signal.aborted) throw new AiError('aborted', 'Request was cancelled by the browser');
    if (e && e.name === 'AbortError') throw new AiError('timeout', `${label} did not answer within ${(timeoutMs || LIMITS.TIMEOUT_MS) / 1000}s`);
    throw new AiError('network', `The server could not reach ${label}`, scrub(e && e.message, apiKey));
  }

  if (!res.ok) {
    // A model rejecting response_format (some providers are picky) → retry once without it.
    if ((res.status === 400 || res.status === 422) && body.response_format) {
      delete body.response_format;
      try {
        ({ res, json, text } = await fetchJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...extraHeaders },
          body: JSON.stringify(body),
        }, { signal, timeoutMs }));
      } catch (e) { /* fall through to error handling below with the original res */ }
    }
  }

  if (!res.ok) {
    const msg = scrub(String((json && (json.error && json.error.message || json.message)) || text || '').replace(/\s+/g, ' ').slice(0, 250), apiKey);
    const code = httpErrorCode(res.status);
    const info = `${label} HTTP ${res.status}${msg ? ': ' + msg : ''}`;
    if (code === 'config' && res.status === 404) throw new AiError('config', `${label}: model "${model}" not found — check the configured model name`, info);
    if (code === 'config') throw new AiError('config', `${label} rejected the API key`, info);
    if (code === 'rate_limited') throw new AiError('rate_limited', `${label} usage limit reached (HTTP 429)`, info);
    if (code === 'upstream') throw new AiError('upstream', `${label} had a server problem (HTTP ${res.status})`, info);
    throw new AiError(code, `${label} rejected the request`, info);
  }

  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  let content = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!content) throw new AiError('empty', `${label} returned an empty answer`, `finish_reason=${(choice && choice.finish_reason) || 'none'}`);
  const data = parseModelJson(content);
  if (!data) throw new AiError('invalid_json', `${label} answer was not readable JSON`, content.slice(0, 200));

  return {
    success: true, provider: id, model, data,
    confidence: typeof data.confidence === 'number' ? data.confidence : null,
    processingTimeMs: now() - started, error: null,
  };
}

// ── CLOUDFLARE WORKERS AI (different request/response shape) ──
async function callCloudflare({ id, label, apiKey, accountId, model, image, index, total, signal, timeoutMs }) {
  const started = now();
  if (!apiKey || !accountId) throw new AiError('config', `${label}: CLOUDFLARE_API_KEY / CLOUDFLARE_ACCOUNT_ID not set`);
  if (!image || !image.base64 || !image.mime) throw new AiError('bad_image', 'Screenshot data is missing');

  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
  const imageBytes = Array.from(Buffer.from(image.base64, 'base64'));
  const body = { image: imageBytes, prompt: buildUserTextForProvider(index, total), max_tokens: 1024 };

  let res, json, text;
  try {
    ({ res, json, text } = await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    }, { signal, timeoutMs }));
  } catch (e) {
    if (signal && signal.aborted) throw new AiError('aborted', 'Request was cancelled by the browser');
    if (e && e.name === 'AbortError') throw new AiError('timeout', `${label} did not answer in time`);
    throw new AiError('network', `The server could not reach ${label}`, scrub(e && e.message, apiKey));
  }

  if (!res.ok || (json && json.success === false)) {
    const msg = scrub(String((json && json.errors && json.errors[0] && json.errors[0].message) || text || '').slice(0, 250), apiKey);
    const code = httpErrorCode(res.status);
    const info = `${label} HTTP ${res.status}${msg ? ': ' + msg : ''}`;
    if (code === 'config') throw new AiError('config', `${label}: request rejected (bad token/account or model "${model}")`, info);
    if (code === 'rate_limited') throw new AiError('rate_limited', `${label} usage limit reached`, info);
    throw new AiError(code === 'bad_request' ? 'bad_request' : 'upstream', `${label} rejected the request`, info);
  }

  const content = (json && json.result && (json.result.response || json.result.description)) || '';
  if (!content) throw new AiError('empty', `${label} returned an empty answer`);
  const data = parseModelJson(content);
  if (!data) throw new AiError('invalid_json', `${label} answer was not readable JSON`, String(content).slice(0, 200));

  return { success: true, provider: id, model, data, confidence: null, processingTimeMs: now() - started, error: null };
}

// ── Wrap the existing Gemini / NVIDIA adapters into the normalized shape ──
async function callGeminiNormalized({ id, apiKey, model, image, index, total, signal }) {
  const started = now();
  const out = await ai.callGemini({ apiKey, model, image, index, total, signal });
  return { success: true, provider: id, model, data: out.data, confidence: null, processingTimeMs: now() - started, error: null };
}

async function callNvidiaNormalized({ id, apiKey, model, baseUrl, image, index, total, signal }) {
  const started = now();
  const out = await ai.callNvidia({ apiKey, model, baseUrl, image, index, total, signal });
  return { success: true, provider: id, model, data: out.data, confidence: null, processingTimeMs: now() - started, error: null };
}

module.exports = {
  callOpenAICompatible, callCloudflare, callGeminiNormalized, callNvidiaNormalized, sleep,
};
