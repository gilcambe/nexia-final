'use strict';
// NEXIA OS — CORTEX SUPREME v16.0 CORRIGIDO
const PLAN_LIMITS = { master: -1, enterprise: -1, pro: 5000, starter: 500, free: 50 };
async function* streamGemini(system, messages, modelId, maxTok) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { yield 'GEMINI_API_KEY nao configurada.'; return; }
  // CORRIGIDO: &alt=sse (nao &amp;alt=sse)
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?key=${key}&alt=sse`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }
  );
}
async function checkAndTrackUsage(tenantId, userId) {
  const plan = tenantDoc?.data().plan || 'free';
  const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free; // CORRIGIDO: fallback
}