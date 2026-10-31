// ════════════════════════════════════════════════════════════
//  MA CRM — ai-router.js
//  Multi-model image extraction router.
//
//  • Reads configured providers from env (ai-providers.js does the actual
//    HTTP calls; this file decides WHICH provider to call and WHEN).
//  • Keeps a running performance score per provider (success rate,
//    validation accuracy, speed, recent failures) persisted in the
//    existing `settings` key/value table — no new database needed.
//  • Staged routing: try the single best provider first; only call a
//    second (or third) provider when the first result is incomplete,
//    low-confidence, or two providers disagree on an important field.
//  • Rate-limit / failure cooldowns so a provider that just failed is
//    skipped for a while instead of being retried into another failure.
// ════════════════════════════════════════════════════════════
const ai = require('./ai-import');
const providers = require('./ai-providers');

const SETTINGS_KEY = 'ai_model_performance_v1';
const SAVE_DEBOUNCE_MS = 4000;

// ── PROVIDER CATALOG ────────────────────────────────────────
// id → how to read its config from env + which adapter to call.
// Order here is only the INITIAL priority (per the spec) — actual routing
// uses the learned score once enough requests have been recorded.
const CATALOG = [
  { id: 'gemini', label: 'Gemini', envKey: 'GEMINI_API_KEY', modelEnv: 'GEMINI_MODEL', defaultModel: 'gemini-3.8-flash' },
  { id: 'groq', label: 'Groq', envKey: 'GROQ_API_KEY', modelEnv: 'GROQ_MODEL', defaultModel: 'llama-3.2-90b-vision-preview', baseUrlDefault: 'https://api.groq.com/openai/v1' },
  { id: 'mistral', label: 'Mistral', envKey: 'MISTRAL_API_KEY', modelEnv: 'MISTRAL_MODEL', defaultModel: 'pixtral-12b-2409', baseUrlDefault: 'https://api.mistral.ai/v1' },
  { id: 'nvidia', label: 'NVIDIA', envKey: 'NVIDIA_API_KEY', modelEnv: 'NVIDIA_MODEL', defaultModel: 'nvidia/muse-glimmer-30b', baseUrlDefault: 'https://integrate.api.nvidia.com/v1' },
  { id: 'llm7', label: 'LLM7', envKey: 'LLM7_API_KEY', modelEnv: 'LLM7_MODEL', defaultModel: 'gpt-4o-mini', baseUrlDefault: 'https://api.llm7.io/v1' },
  { id: 'zai', label: 'Z AI', envKey: 'ZAI_API_KEY', modelEnv: 'ZAI_MODEL', defaultModel: 'glm-4.6v-flash', baseUrlDefault: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'cloudflare', label: 'Cloudflare', envKey: 'CLOUDFLARE_API_KEY', modelEnv: 'CLOUDFLARE_MODEL', defaultModel: '@cf/llava-hf/llava-1.5-7b-hf', extraEnvKey: 'CLOUDFLARE_ACCOUNT_ID' },
  { id: 'kilo', label: 'Kilo', envKey: 'KILO_API_KEY', modelEnv: 'KILO_MODEL', defaultModel: 'gpt-4o-mini', baseUrlDefault: 'https://api.kilo.ai/api/gateway' },
];

// High-value fields used for cross-model agreement/disagreement checks.
const KEY_FIELDS = ['client_name', 'tracking_id', 'cod_amount', 'address'];

function cleanEnv(v) { return String(v || '').replace(/^\uFEFF/, '').trim().replace(/^["']+|["']+$/g, '').split(/\s+/)[0] || ''; }

// ── Build the list of CONFIGURED providers from process.env ───
function loadConfiguredProviders() {
  const out = [];
  for (const def of CATALOG) {
    const apiKey = cleanEnv(process.env[def.envKey]);
    if (!apiKey) continue;                                   // unconfigured → skipped entirely
    if (def.extraEnvKey && !cleanEnv(process.env[def.extraEnvKey])) continue;
    const model = (process.env[def.modelEnv] || def.defaultModel).trim();
    const baseUrl = def.baseUrlDefault ? (process.env[`${def.id.toUpperCase()}_BASE_URL`] || def.baseUrlDefault) : null;
    out.push({
      id: def.id, label: def.label, apiKey, model, baseUrl,
      accountId: def.extraEnvKey ? cleanEnv(process.env[def.extraEnvKey]) : null,
    });
  }
  return out;
}

// Dispatches to the right adapter for one configured provider.
async function callProvider(p, image, index, total, signal) {
  if (p.id === 'gemini') return providers.callGeminiNormalized({ id: p.id, apiKey: p.apiKey, model: p.model, image, index, total, signal });
  if (p.id === 'nvidia') return providers.callNvidiaNormalized({ id: p.id, apiKey: p.apiKey, model: p.model, baseUrl: p.baseUrl, image, index, total, signal });
  if (p.id === 'cloudflare') return providers.callCloudflare({ id: p.id, label: p.label, apiKey: p.apiKey, accountId: p.accountId, model: p.model, image, index, total, signal });
  return providers.callOpenAICompatible({ id: p.id, label: p.label, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, image, index, total, signal });
}

// ── PERFORMANCE STORE ───────────────────────────────────────
// Per-provider rolling stats, persisted as one JSON blob in `settings`.
// Score = Accuracy×0.50 + Confidence×0.20 + Reliability×0.15 + Speed×0.10 + Availability×0.05
function blankStats() {
  return {
    totalRequests: 0, successfulRequests: 0, failedRequests: 0, validationFailures: 0,
    accuracySum: 0, accuracyCount: 0,           // from validateExtractedData() scores, not model self-confidence
    avgProcessingTimeMs: 0, rateLimitCount: 0,
    lastUsed: null, lastFailure: null, cooldownUntil: 0, recentFailures: 0,
  };
}

function createPerformanceStore({ dbGet, dbRun }) {
  let stats = {};   // provider id → blankStats()
  let dirty = false;
  let saveTimer = null;

  async function load() {
    try {
      const row = dbGet ? await dbGet(`SELECT value FROM settings WHERE key=?`, [SETTINGS_KEY]) : null;
      if (row && row.value) stats = JSON.parse(row.value) || {};
    } catch (e) { console.warn('[ai-router] could not load saved performance stats:', e.message); }
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      if (!dirty || !dbRun) return;
      dirty = false;
      try {
        await dbRun(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
          [SETTINGS_KEY, JSON.stringify(stats)]
        ).catch(async () => {
          // SQLite without ON CONFLICT support on old builds / Postgres dialect mismatch fallback
          const existing = await dbGet(`SELECT key FROM settings WHERE key=?`, [SETTINGS_KEY]);
          if (existing) await dbRun(`UPDATE settings SET value=? WHERE key=?`, [JSON.stringify(stats), SETTINGS_KEY]);
          else await dbRun(`INSERT INTO settings (key, value) VALUES (?, ?)`, [SETTINGS_KEY, JSON.stringify(stats)]);
        });
      } catch (e) { console.warn('[ai-router] could not save performance stats:', e.message); }
    }, SAVE_DEBOUNCE_MS);
  }

  function get(id) {
    if (!stats[id]) stats[id] = blankStats();
    return stats[id];
  }

  // validationScore: 0..1 from validateExtractedData() — NOT the model's own confidence claim.
  function recordSuccess(id, { processingTimeMs, validationScore }) {
    const s = get(id);
    s.totalRequests++; s.successfulRequests++; s.recentFailures = 0;
    s.lastUsed = Date.now();
    s.avgProcessingTimeMs = s.avgProcessingTimeMs ? Math.round(s.avgProcessingTimeMs * 0.8 + processingTimeMs * 0.2) : processingTimeMs;
    if (typeof validationScore === 'number') { s.accuracySum += validationScore; s.accuracyCount++; }
    else s.validationFailures++;
    scheduleSave();
  }

  function recordFailure(id, { rateLimited = false } = {}) {
    const s = get(id);
    s.totalRequests++; s.failedRequests++; s.recentFailures = (s.recentFailures || 0) + 1;
    s.lastFailure = Date.now();
    if (rateLimited) s.rateLimitCount++;
    scheduleSave();
  }

  // User correction = training signal (spec: "USER CORRECTION = TRAINING SIGNAL").
  // Call this when a human edits an AI-extracted field before saving.
  function recordCorrection(id, fieldsWrong, fieldsTotal) {
    if (!fieldsTotal) return;
    const s = get(id);
    const correctFrac = Math.max(0, 1 - fieldsWrong / fieldsTotal);
    s.accuracySum += correctFrac; s.accuracyCount++;
    scheduleSave();
  }

  function setCooldown(id, untilTs) {
    get(id).cooldownUntil = untilTs;
    scheduleSave();
  }

  function score(id) {
    const s = get(id);
    if (s.totalRequests === 0) return 0.5;   // unknown provider — neutral score, let it prove itself
    const accuracy = s.accuracyCount ? (s.accuracySum / s.accuracyCount) : 0.5;
    const reliability = s.successfulRequests / s.totalRequests;
    const confidence = accuracy;              // no independent self-confidence channel is trusted alone — reuse validated accuracy
    const speed = s.avgProcessingTimeMs ? Math.max(0, Math.min(1, 1 - (s.avgProcessingTimeMs - 500) / 4500)) : 0.5;
    const availability = Date.now() < (s.cooldownUntil || 0) ? 0 : (1 - Math.min(1, (s.recentFailures || 0) / 5));
    return accuracy * 0.50 + confidence * 0.20 + reliability * 0.15 + speed * 0.10 + availability * 0.05;
  }

  function snapshot() {
    const out = {};
    for (const [id, s] of Object.entries(stats)) {
      out[id] = {
        ...s,
        successRate: s.totalRequests ? +(s.successfulRequests / s.totalRequests * 100).toFixed(1) : null,
        accuracy: s.accuracyCount ? +(s.accuracySum / s.accuracyCount * 100).toFixed(1) : null,
        score: +score(id).toFixed(3),
      };
    }
    return out;
  }

  return { load, get, recordSuccess, recordFailure, recordCorrection, setCooldown, score, snapshot };
}

// ── VALIDATION SCORE ────────────────────────────────────────
// Turns ai.validateParcel()'s per-field output into one 0..1 score used
// both for routing decisions ("is this result good enough, or try another
// model?") and for the provider's recorded accuracy.
function validationScore(validated) {
  const weight = { client_name: 1, address: 1, tracking_id: 1, cod_amount: 1, phones: 1 };
  let got = 0, total = 0;
  for (const k of ['client_name', 'address', 'tracking_id', 'cod_amount']) {
    total += weight[k];
    const f = validated[k];
    if (f && f.value !== null && f.value !== undefined && f.value !== '') got += (f.confidence === 'low' ? 0.5 : 1) * weight[k];
  }
  total += weight.phones;
  if (Array.isArray(validated.phones) && validated.phones.length) {
    got += (validated.phones.some(p => p.confidence !== 'low') ? 1 : 0.5) * weight.phones;
  }
  return total ? got / total : 0;
}

function isGoodEnough(validated, score) {
  return score >= 0.75;      // "complete, valid, high confidence" per spec Stage 1
}

// Compares two validated results on the high-priority fields; returns the
// list of fields where they meaningfully disagree.
function disagreements(a, b) {
  const diffs = [];
  for (const k of KEY_FIELDS) {
    const av = a[k] && a[k].value, bv = b[k] && b[k].value;
    if (av === null || av === undefined || bv === null || bv === undefined) continue;   // one side silent isn't a disagreement
    const norm = v => String(v).toLowerCase().replace(/\s+/g, ' ').trim();
    if (norm(av) !== norm(bv)) diffs.push(k);
  }
  return diffs;
}

function isTransient(e) {
  if (!e) return false;
  if (['config', 'bad_request', 'blocked', 'bad_image', 'aborted'].includes(e.code)) return false;
  const text = `${e.message || ''} ${e.detail || ''}`;
  return e.code === 'timeout' || e.code === 'network' || /\b(500|502|503|504)\b|UNAVAILABLE|overloaded|INTERNAL/i.test(text);
}

// ── STAGED EXTRACTION FOR ONE IMAGE ────────────────────────
// Stage 1: best-scored available provider. Accept immediately if good.
// Stage 2: result incomplete/low-confidence/invalid → try next provider.
// Stage 3: the two results disagree on a key field → verify with a third.
// Returns: { ok, data (validated parcel shape), provider, attempts: [...] }
async function extractImage({ perf, perProviderLock }, configured, image, index, total, { log = () => {}, signal = null, maxProviders = 3 } = {}) {
  const now = Date.now();
  const ranked = configured
    .filter(p => now >= (perf.get(p.id).cooldownUntil || 0))
    .sort((a, b) => perf.score(b.id) - perf.score(a.id));
  const pool = ranked.length ? ranked : configured;   // everyone cooling down → try anyway rather than fail outright
  if (!pool.length) throw new ai.AiError('config', 'No AI provider is configured on the server');

  const attempts = [];
  let best = null;     // { provider, validated, score }

  for (let i = 0; i < Math.min(pool.length, maxProviders); i++) {
    const p = pool[i];
    const started = Date.now();
    try {
      const out = await callProvider(p, image, index, total, signal);
      const validated = ai.validateParcel(out.data);
      const vScore = validationScore(validated);
      perf.recordSuccess(p.id, { processingTimeMs: Date.now() - started, validationScore: vScore });
      attempts.push({ provider: p.id, label: p.label, ok: true, score: vScore, ms: Date.now() - started });
      log(`${p.label} answered (validation score ${vScore.toFixed(2)}) in ${Date.now() - started}ms`);

      if (!best || vScore > best.score) best = { provider: p, validated, score: vScore };

      if (i === 0) {
        // Stage 1 — accept immediately if the first provider's answer is already good.
        if (isGoodEnough(validated, vScore)) return { ok: true, data: validated, provider: p, attempts };
        log(`${p.label} result below confidence threshold (${vScore.toFixed(2)}) — trying a second provider`);
        continue;
      }

      // Stage 2/3 — compare against the previous best; agreement raises confidence,
      // disagreement on a key field triggers one more provider (Stage 3) when budget allows.
      const prev = attempts[attempts.length - 2];
      if (prev && prev.ok) {
        const diffs = disagreements(best.validated || validated, validated);
        if (!diffs.length && isGoodEnough(validated, Math.max(vScore, best.score))) {
          return { ok: true, data: best.validated, provider: best.provider, attempts, verified: true };
        }
        if (diffs.length) {
          log(`Providers disagree on: ${diffs.join(', ')}`);
          if (i + 1 >= maxProviders) break;   // out of budget — fall through to "use best so far"
          continue;                           // Stage 3: one more provider
        }
      }
      if (isGoodEnough(validated, vScore)) return { ok: true, data: validated, provider: p, attempts };
    } catch (e) {
      const code = e.code || 'upstream';
      attempts.push({ provider: p.id, label: p.label, ok: false, code, error: e.message });
      if (code === 'rate_limited') {
        perf.setCooldown(p.id, Date.now() + 120000);
        perf.recordFailure(p.id, { rateLimited: true });
        log(`${p.label} rate-limited (HTTP 429) — cooling down, trying next provider`);
      } else if (code === 'config') {
        perf.setCooldown(p.id, Date.now() + 600000);
        perf.recordFailure(p.id);
        log(`${p.label} unusable (${e.message}) — cooling down, trying next provider`);
      } else if (!isTransient(e)) {
        perf.setCooldown(p.id, Date.now() + 30000);
        perf.recordFailure(p.id);
        log(`${p.label} failed (${code}) — trying next provider`);
      } else {
        perf.recordFailure(p.id);
        log(`${p.label} busy/unreachable — trying next provider`);
      }
      if (e.code === 'aborted') throw e;
    }
  }

  if (best) return { ok: true, data: best.validated, provider: best.provider, attempts, uncertain: true };
  return { ok: false, attempts };
}

module.exports = {
  CATALOG, loadConfiguredProviders, createPerformanceStore, extractImage,
  validationScore, disagreements, isGoodEnough, callProvider,
};
