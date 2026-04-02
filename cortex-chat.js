'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS — CORTEX SUPREME v16.0                                     ║
 * ║  50 Providers de IA — Free Tier Prioritário                         ║
 * ║  Firebase seguro, streaming real, sem crashes                       ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

let admin, db;
try {
  admin = require('firebase-admin');
  if (!admin.apps.length) {
    const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
    const saB64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!saRaw && !saB64) throw new Error('FIREBASE_SERVICE_ACCOUNT não configurada');
    const saJson = saRaw || Buffer.from(saB64, 'base64').toString('utf8');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saJson)) });
  }
  db = admin.firestore();
} catch (e) {
  console.warn('[CORTEX] Firebase indisponível:', e.message);
  db = null;
}

let memModule, actionModule, learnModule, autodevModule, ragModule;
try { memModule = require('./cortex-memory'); } catch { memModule = { load: async () => ({ history: [], summaries: [] }), save: async () => {}, buildContext: (h) => h, extractEntities: () => ({}) }; }
try { actionModule = require('./action-engine'); } catch { actionModule = { dispatch: async () => ({ ok: false, error: 'action-engine indisponível' }) }; }
try { learnModule = require('./cortex-learn'); } catch { learnModule = { buildLearningContext: async () => null, saveExample: async () => {} }; }
try { autodevModule = require('./autodev-engine'); } catch { autodevModule = null; }
try { ragModule = require('./rag-engine'); } catch { ragModule = { buildRAGContext: async () => '' }; }

const { guard, sanitizePrompt, validateAIAction, checkPermission, HEADERS, makeHeaders } = require('./middleware');

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'Access-Control-Allow-Origin': (process.env.NEXIA_APP_URL ? process.env.NEXIA_APP_URL.split(',')[0].trim() : '*'),
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'X-Accel-Buffering': 'no'
};

const PLAN_LIMITS = { master: -1, enterprise: -1, pro: 5000, starter: 500, free: 50 };

// ══════════════════════════════════════════════════════════════════════
// 50 PROVIDERS — 🆓 Free | 💰 Pago | 🎁 Créditos signup
// ══════════════════════════════════════════════════════════════════════
const AI_CATALOG = {
  // ANTHROPIC (pago)
  claude:               { provider: 'anthropic',   model: 'claude-sonnet-4-6',                                    label: '✦ Claude Sonnet 4.6',          free: false },
  claude_opus:          { provider: 'anthropic',   model: 'claude-opus-4-6',                                      label: '✦ Claude Opus 4.6',            free: false },
  claude_haiku:         { provider: 'anthropic',   model: 'claude-haiku-4-5-20251001',                            label: '✦ Claude Haiku 4.5',           free: false },

  // OPENAI (pago)
  gpt4o:                { provider: 'openai',      model: 'gpt-4o',                                               label: '⚡ GPT-4o',                     free: false },
  gpt4o_mini:           { provider: 'openai',      model: 'gpt-4o-mini',                                          label: '⚡ GPT-4o Mini',                free: false },

  // GROQ 🆓 — https://console.groq.com — GROQ_API_KEY
  groq_llama4_scout:    { provider: 'groq',        model: 'meta-llama/llama-4-scout-17b-16e-instruct',            label: '🦙 Llama 4 Scout (Groq)',      free: true  },
  groq_llama4_maverick: { provider: 'groq',        model: 'meta-llama/llama-4-maverick-17b-128e-instruct',        label: '🦙 Llama 4 Maverick (Groq)',   free: true  },
  groq_llama3:          { provider: 'groq',        model: 'llama3-70b-8192',                                      label: '🦙 Llama 3 70B (Groq)',        free: true  },
  groq_llama3_fast:     { provider: 'groq',        model: 'llama-3.1-8b-instant',                                 label: '🦙 Llama 3.1 8B Fast (Groq)', free: true  },
  groq_mixtral:         { provider: 'groq',        model: 'mixtral-8x7b-32768',                                   label: '🔥 Mixtral 8x7B (Groq)',       free: true  },
  groq_gemma2:          { provider: 'groq',        model: 'gemma2-9b-it',                                         label: '💎 Gemma 2 9B (Groq)',         free: true  },
  groq_qwen:            { provider: 'groq',        model: 'qwen-qwq-32b',                                         label: '🐉 Qwen QwQ 32B (Groq)',       free: true  },
  groq_deepseek_r1:     { provider: 'groq',        model: 'deepseek-r1-distill-llama-70b',                        label: '💻 DeepSeek R1 (Groq)',        free: true  },

  // GEMINI 🆓 — https://aistudio.google.com — GEMINI_API_KEY
  gemini_25_pro:        { provider: 'gemini',      model: 'gemini-2.5-pro',                                       label: '🌐 Gemini 2.5 Pro',            free: true  },
  gemini_25_flash:      { provider: 'gemini',      model: 'gemini-2.5-flash',                                     label: '🌐 Gemini 2.5 Flash',          free: true  },
  gemini_20_flash:      { provider: 'gemini',      model: 'gemini-2.0-flash',                                     label: '🌐 Gemini 2.0 Flash',          free: true  },
  gemini_flash_lite:    { provider: 'gemini',      model: 'gemini-2.5-flash-lite',                                label: '🌐 Gemini Flash Lite',         free: true  },

  // CEREBRAS 🆓 — https://cloud.cerebras.ai — CEREBRAS_API_KEY
  cerebras_llama4:      { provider: 'cerebras',    model: 'llama-4-scout-17b-16e-instruct',                       label: '⚡ Llama 4 Scout (Cerebras)', free: true  },
  cerebras_llama3:      { provider: 'cerebras',    model: 'llama3.3-70b',                                         label: '⚡ Llama 3.3 70B (Cerebras)', free: true  },
  cerebras_qwen:        { provider: 'cerebras',    model: 'qwen-3-32b',                                           label: '⚡ Qwen 3 32B (Cerebras)',    free: true  },

  // OPENROUTER 🆓 — https://openrouter.ai/keys — OPENROUTER_API_KEY
  or_llama4_mav:        { provider: 'openrouter',  model: 'meta-llama/llama-4-maverick:free',                     label: '🌐 Llama 4 Maverick (OR)',    free: true  },
  or_deepseek_r1:       { provider: 'openrouter',  model: 'deepseek/deepseek-r1:free',                            label: '🌐 DeepSeek R1 (OR)',          free: true  },
  or_deepseek_v3:       { provider: 'openrouter',  model: 'deepseek/deepseek-v3-0324:free',                       label: '🌐 DeepSeek V3 (OR)',          free: true  },
  or_qwen3_235b:        { provider: 'openrouter',  model: 'qwen/qwen3-235b-a22b:free',                            label: '🌐 Qwen3 235B (OR)',           free: true  },
  or_qwen3_coder:       { provider: 'openrouter',  model: 'qwen/qwen3-coder-480b:free',                           label: '🌐 Qwen3 Coder 480B (OR)',    free: true  },
  or_gemma3_27b:        { provider: 'openrouter',  model: 'google/gemma-3-27b-it:free',                           label: '🌐 Gemma 3 27B (OR)',          free: true  },
  or_mistral_sm:        { provider: 'openrouter',  model: 'mistralai/mistral-small-3.1-24b-instruct:free',        label: '🌐 Mistral Small 3.1 (OR)',   free: true  },
  or_nvidia_nemotron:   { provider: 'openrouter',  model: 'nvidia/llama-3.1-nemotron-ultra-253b-v1:free',         label: '🌐 NVIDIA Nemotron 253B (OR)',free: true  },
  or_gpt_oss_120b:      { provider: 'openrouter',  model: 'openai/gpt-oss-120b:free',                             label: '🌐 GPT-OSS 120B (OR)',         free: true  },

  // MISTRAL 🆓 — https://console.mistral.ai — MISTRAL_API_KEY
  mistral_small:        { provider: 'mistral',     model: 'mistral-small-latest',                                 label: '🇫🇷 Mistral Small',             free: true  },
  mistral_codestral:    { provider: 'mistral',     model: 'codestral-latest',                                     label: '🇫🇷 Codestral (código)',         free: true  },
  mistral_nemo:         { provider: 'mistral',     model: 'open-mistral-nemo',                                    label: '🇫🇷 Mistral Nemo 12B',           free: true  },

  // COHERE 🆓 — https://dashboard.cohere.com — COHERE_API_KEY
  cohere_command:       { provider: 'cohere',      model: 'command-r-plus',                                       label: '🔵 Cohere Command R+',         free: true  },
  cohere_command_r:     { provider: 'cohere',      model: 'command-r',                                            label: '🔵 Cohere Command R',          free: true  },

  // NVIDIA NIM 🆓 — https://build.nvidia.com — NVIDIA_API_KEY
  nvidia_llama3:        { provider: 'nvidia',      model: 'meta/llama-3.3-70b-instruct',                          label: '🟢 Llama 3.3 70B (NVIDIA)',   free: true  },
  nvidia_deepseek_r1:   { provider: 'nvidia',      model: 'deepseek/deepseek-r1',                                 label: '🟢 DeepSeek R1 (NVIDIA)',      free: true  },
  nvidia_phi4:          { provider: 'nvidia',      model: 'microsoft/phi-4',                                      label: '🟢 Phi-4 (NVIDIA)',            free: true  },
  nvidia_gemma3_27b:    { provider: 'nvidia',      model: 'google/gemma-3-27b-it',                                label: '🟢 Gemma 3 27B (NVIDIA)',      free: true  },

  // HUGGING FACE 🆓 — https://huggingface.co/settings/tokens — HF_API_KEY
  hf_llama3:            { provider: 'huggingface', model: 'meta-llama/Llama-3.3-70B-Instruct',                    label: '🤗 Llama 3.3 70B (HF)',       free: true  },
  hf_qwen3:             { provider: 'huggingface', model: 'Qwen/Qwen3-235B-A22B',                                 label: '🤗 Qwen3 235B (HF)',           free: true  },
  hf_deepseek_r1:       { provider: 'huggingface', model: 'deepseek-ai/DeepSeek-R1',                              label: '🤗 DeepSeek R1 (HF)',          free: true  },

  // SAMBANOVA 🆓 — https://cloud.sambanova.ai — SAMBANOVA_API_KEY
  sambanova_llama3:     { provider: 'sambanova',   model: 'Meta-Llama-3.3-70B-Instruct',                          label: '🔴 Llama 3.3 70B (SambaNova)',free: true  },
  sambanova_deepseek:   { provider: 'sambanova',   model: 'DeepSeek-R1-Distill-Llama-70B',                        label: '🔴 DeepSeek R1 (SambaNova)',   free: true  },
  sambanova_qwen:       { provider: 'sambanova',   model: 'Qwen3-32B',                                            label: '🔴 Qwen3 32B (SambaNova)',     free: true  },

  // TOGETHER AI 🎁 — https://api.together.xyz — TOGETHER_API_KEY
  together_llama4:      { provider: 'together',    model: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',            label: '🤝 Llama 4 Scout (Together)', free: true  },
  together_deepseek:    { provider: 'together',    model: 'deepseek-ai/DeepSeek-R1',                              label: '🤝 DeepSeek R1 (Together)',   free: true  },

  // DEEPSEEK 💰
  deepseek_v3:          { provider: 'deepseek',    model: 'deepseek-chat',                                        label: '💻 DeepSeek V3',               free: false },
  deepseek_r1:          { provider: 'deepseek',    model: 'deepseek-reasoner',                                    label: '💻 DeepSeek R1',               free: false },
  deepseek_coder:       { provider: 'deepseek',    model: 'deepseek-coder',                                       label: '💻 DeepSeek Coder',            free: false },

  // XAI (pago)
  grok3:                { provider: 'xai',         model: 'grok-3-fast',                                          label: '🚀 Grok-3 Fast',               free: false },

  // PERPLEXITY (pago)
  perplexity:           { provider: 'perplexity',  model: 'llama-3.1-sonar-large-128k-online',                    label: '🔍 Perplexity',                free: false },
  perplexity_fast:      { provider: 'perplexity',  model: 'llama-3.1-sonar-small-128k-online',                    label: '🔍 Perplexity Fast',           free: false },
};

// Roteador por intent — 100% free tier por padrão
const INTENT_ROUTER = {
  code:      'or_qwen3_coder',
  dev:       'groq_deepseek_r1',
  security:  'gemini_25_flash',
  write:     'cerebras_llama4',
  legal:     'gemini_25_pro',
  analysis:  'gemini_25_flash',
  vision:    'gemini_20_flash',
  search:    'perplexity',
  news:      'perplexity_fast',
  finance:   'groq_llama4_maverick',
  huge_doc:  'gemini_25_pro',
  realtime:  'grok3',
  fast:      'cerebras_llama3',
  chat:      'groq_llama4_scout',
  swarm:     'or_qwen3_235b',
  action:    'groq_llama3_fast',
  auto:      'groq_llama4_scout',
  reasoning: 'or_deepseek_r1',
  rag:       'cohere_command_r',
};

const STATIC_AGENTS = {
  orchestrator: { system: `Você é o CORTEX ORCHESTRATOR v16. Analise a mensagem e retorne SOMENTE JSON válido, sem texto fora do JSON:\n{"type":"chat|code|action|swarm|image","intent":"chat|code|dev|security|write|legal|analysis|vision|search|news|finance|huge_doc|realtime|fast","agents":["dev","security","business"],"actions":[{"type":"createTask","data":{}}],"image_request":{"prompt":"...","style":"realistic"},"model_override":"groq_llama4_scout|or_deepseek_r1|gemini_25_pro|cerebras_llama3|claude|gpt4o","response":"Resposta em português"}` },
  dev:       { system: 'Você é o DEV AGENT — Principal Engineer da NEXIA. Especialista em Firebase, Netlify Functions, JavaScript, TypeScript, React, Python, arquitetura SaaS multi-tenant. Responda em português com código completo e funcional.' },
  security:  { system: 'Você é o SECURITY AGENT — CISO Virtual da NEXIA. Especialista em OWASP, LGPD/GDPR, Firebase Security Rules, pentest, criptografia. Responda em português, nunca minimize riscos.' },
  business:  { system: 'Você é o BUSINESS AGENT — Consultor Estratégico da NEXIA. Especialista em SaaS, MRR, churn, pricing, vendas, marketing. Responda em português de forma executiva.' },
  finance:   { system: 'Você é o FINANCE AGENT — CFO Virtual da NEXIA. Especialista em DRE, fluxo de caixa, valuation, análise de crédito. Responda com precisão numérica.' },
  legal:     { system: 'Você é o LEGAL AGENT — especialista em contratos SaaS, LGPD, editais. Analise contratos e identifique riscos. Responda em português acessível.' },
  architect: { system: 'Você é o ARCHITECT AGENT — especialista em arquitetura de sistemas, microserviços, serverless, bancos de dados. Projete sistemas robustos. Responda em português.' },
};

// ═══ STREAMING ════════════════════════════════════════════════════════
async function* streamAnthropic(system, messages, modelId, maxTok) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { yield '⚠️ **ANTHROPIC_API_KEY não configurada.** Adicione no Netlify → Environment Variables.'; return; }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId || 'claude-sonnet-4-6', max_tokens: maxTok || 16000, stream: true, system, messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: String(m.content) })) })
    });
    if (!res.ok) { yield `❌ Anthropic Error (${res.status}): ${await res.text().catch(() => '')}`; return; }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim(); if (d === '[DONE]') return;
        try { const p = JSON.parse(d); if (p.type === 'content_block_delta' && p.delta?.type === 'text_delta') yield p.delta.text; } catch { }
      }
    }
  } catch (e) { yield `❌ Erro Anthropic: ${e.message}`; }
}

async function* streamOpenAI(system, messages, modelId, maxTok) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) { yield '⚠️ **OPENAI_API_KEY não configurada.** Adicione no Netlify → Environment Variables.'; return; }
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId || 'gpt-4o', max_tokens: maxTok || 16000, stream: true, messages: [{ role: 'system', content: system }, ...messages] })
    });
    if (!res.ok) { yield `❌ OpenAI Error (${res.status}): ${await res.text().catch(() => '')}`; return; }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim(); if (d === '[DONE]') return;
        try { const t = JSON.parse(d).choices?.[0]?.delta?.content; if (t) yield t; } catch { }
      }
    }
  } catch (e) { yield `❌ Erro OpenAI: ${e.message}`; }
}

async function* streamGroq(system, messages, modelId, maxTok) {
  const key = process.env.GROQ_API_KEY;
  if (!key) { yield '⚠️ **GROQ_API_KEY não configurada.**\n\nCadastre GRÁTIS em: https://console.groq.com\nAdicione no Netlify → Environment Variables.'; return; }
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId || 'llama3-70b-8192', max_tokens: Math.min(maxTok || 8192, 8192), stream: true, temperature: 0.4, messages: [{ role: 'system', content: system }, ...messages] })
    });
    if (!res.ok) { yield `❌ Groq Error (${res.status}): ${await res.text().catch(() => '')}`; return; }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim(); if (d === '[DONE]') return;
        try { const t = JSON.parse(d).choices?.[0]?.delta?.content; if (t) yield t; } catch { }
      }
    }
  } catch (e) { yield `❌ Erro Groq: ${e.message}`; }
}

async function* streamGemini(system, messages, modelId, maxTok) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { yield '⚠️ **GEMINI_API_KEY não configurada.**\n\nCadastre GRÁTIS em: https://aistudio.google.com\nAdicione no Netlify → Environment Variables.'; return; }
  try {
    const gemMessages = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content) }] }));
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId || 'gemini-2.0-flash'}:streamGenerateContent?key=${key}&alt=sse`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: gemMessages, generationConfig: { maxOutputTokens: maxTok || 8192 } })
    });
    if (!res.ok) { yield `❌ Gemini Error (${res.status}): ${await res.text().catch(() => '')}`; return; }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim(); if (d === '[DONE]') return;
        try { const t = JSON.parse(d).candidates?.[0]?.content?.parts?.[0]?.text; if (t) yield t; } catch { }
      }
    }
  } catch (e) { yield `❌ Erro Gemini: ${e.message}`; }
}

async function* streamCerebras(system, messages, modelId, maxTok) {
  const key = process.env.CEREBRAS_API_KEY;
  if (!key) { yield '⚠️ **CEREBRAS_API_KEY não configurada.**\n\nCadastre GRÁTIS (1M tokens/dia) em: https://cloud.cerebras.ai'; return; }
  try {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId || 'llama3.3-70b', max_tokens: Math.min(maxTok || 8192, 8192), stream: true, messages: [{ role: 'system', content: system }, ...messages] })
    });
    if (!res.ok) { yield `❌ Cerebras Error (${res.status}): ${await res.text().catch(() => '')}`; return; }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim(); if (d === '[DONE]') return;
        try { const t = JSON.parse(d).choices?.[0]?.delta?.content; if (t) yield t; } catch { }
      }
    }
  } catch (e) { yield `❌ Erro Cerebras: ${e.message}`; }
}

async function* streamOpenRouter(system, messages, modelId, maxTok) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { yield '⚠️ **OPENROUTER_API_KEY não configurada.**\n\nCadastre GRÁTIS (50+ modelos free) em: https://openrouter.ai/keys'; return; }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': process.env.NEXIA_APP_URL || 'https://nexiaos.netlify.app', 'X-Title': 'NEXIA OS' },
      body: JSON.stringify({ model: modelId, max_tokens: maxTok || 8192, stream: true, messages: [{ role: 'system', content: system }, ...messages] })
    });
    if (!res.ok) { yield `❌ OpenRouter Error (${res.status}): ${await res.text().catch(() => '')}`; return; }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim(); if (d === '[DONE]') return;
        try { const t = JSON.parse(d).choices?.[0]?.delta?.content; if (t) yield t; } catch { }
      }
    }
  } catch (e) { yield `❌ Erro OpenRouter: ${e.message}`; }
}

async function* streamPerplexity(system, messages, modelId, maxTok) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) { yield '⚠️ **PERPLEXITY_API_KEY não configurada** para busca em tempo real.'; return; }
  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId || 'llama-3.1-sonar-large-128k-online', max_tokens: maxTok || 4096, stream: true, messages: [{ role: 'system', content: system }, ...messages] })
    });
    if (!res.ok) { yield `❌ Perplexity Error (${res.status})`; return; }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim(); if (d === '[DONE]') return;
        try { const t = JSON.parse(d).choices?.[0]?.delta?.content; if (t) yield t; } catch { }
      }
    }
  } catch (e) { yield `❌ Erro Perplexity: ${e.message}`; }
}

// ═══ CHAMADAS SÍNCRONAS ═══════════════════════════════════════════════
async function callFreeProvider(provider, model, system, messages, maxTok) {
  const cfgs = {
    mistral:     { url: 'https://api.mistral.ai/v1/chat/completions',                                            key: process.env.MISTRAL_API_KEY,    signup: 'https://console.mistral.ai' },
    cohere:      { url: 'https://api.cohere.ai/v2/chat',                                                         key: process.env.COHERE_API_KEY,     signup: 'https://dashboard.cohere.com', cohere: true },
    nvidia:      { url: 'https://integrate.api.nvidia.com/v1/chat/completions',                                  key: process.env.NVIDIA_API_KEY,     signup: 'https://build.nvidia.com' },
    huggingface: { url: `https://router.huggingface.co/hf-inference/models/${model}/v1/chat/completions`,        key: process.env.HF_API_KEY,         signup: 'https://huggingface.co/settings/tokens' },
    sambanova:   { url: 'https://api.sambanova.ai/v1/chat/completions',                                          key: process.env.SAMBANOVA_API_KEY,  signup: 'https://cloud.sambanova.ai' },
    together:    { url: 'https://api.together.xyz/v1/chat/completions',                                          key: process.env.TOGETHER_API_KEY,   signup: 'https://api.together.xyz' },
  };
  const cfg = cfgs[provider];
  if (!cfg) throw new Error(`Provider desconhecido: ${provider}`);
  if (!cfg.key) throw new Error(`${provider.toUpperCase()}_API_KEY não configurada. Cadastre GRÁTIS em: ${cfg.signup}`);
  const body = cfg.cohere
    ? { model, messages: [{ role: 'system', content: system }, ...messages], max_tokens: maxTok || 4096 }
    : { model, max_tokens: Math.min(maxTok || 8192, 8192), messages: [{ role: 'system', content: system }, ...messages] };
  const res = await fetch(cfg.url, { method: 'POST', headers: { 'Authorization': `Bearer ${cfg.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${await res.text().catch(() => '')}`);
  const d = await res.json();
  if (cfg.cohere) return d.message?.content?.[0]?.text || d.text || '';
  return d.choices?.[0]?.message?.content || '';
}

async function callSync(system, messages, modelKey, maxTok) {
  const ai = AI_CATALOG[modelKey] || AI_CATALOG.groq_llama3;
  const { provider, model } = ai;
  const tok = maxTok || 8192;

  if (provider === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('ANTHROPIC_API_KEY ausente');
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: tok, system, messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: String(m.content) })) }) });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    return (await res.json()).content?.[0]?.text || '';
  }
  if (provider === 'groq') {
    const key = process.env.GROQ_API_KEY; if (!key) throw new Error('GROQ_API_KEY ausente');
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, max_tokens: Math.min(tok, 8192), temperature: 0.3, messages: [{ role: 'system', content: system }, ...messages] }) });
    if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
    return (await res.json()).choices[0].message.content;
  }
  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY; if (!key) throw new Error('OPENAI_API_KEY ausente');
    const res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, max_tokens: tok, messages: [{ role: 'system', content: system }, ...messages] }) });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    return (await res.json()).choices[0].message.content;
  }
  if (provider === 'deepseek') {
    const key = process.env.DEEPSEEK_API_KEY; if (!key) throw new Error('DEEPSEEK_API_KEY ausente');
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, max_tokens: Math.min(tok, 8192), temperature: 0.1, messages: [{ role: 'system', content: system }, ...messages] }) });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
    return (await res.json()).choices[0].message.content;
  }
  if (provider === 'gemini') {
    const key = process.env.GEMINI_API_KEY; if (!key) throw new Error('GEMINI_API_KEY ausente — grátis em https://aistudio.google.com');
    const gemMessages = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: gemMessages, generationConfig: { maxOutputTokens: tok } }) });
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    return (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  if (provider === 'xai') {
    const key = process.env.XAI_API_KEY; if (!key) throw new Error('XAI_API_KEY ausente');
    const res = await fetch('https://api.x.ai/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, max_tokens: tok, messages: [{ role: 'system', content: system }, ...messages] }) });
    if (!res.ok) throw new Error(`Grok ${res.status}`);
    return (await res.json()).choices[0].message.content;
  }
  if (provider === 'perplexity') {
    const key = process.env.PERPLEXITY_API_KEY; if (!key) throw new Error('PERPLEXITY_API_KEY ausente');
    const res = await fetch('https://api.perplexity.ai/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, max_tokens: tok, messages: [{ role: 'system', content: system }, ...messages] }) });
    if (!res.ok) throw new Error(`Perplexity ${res.status}`);
    return (await res.json()).choices[0].message.content;
  }
  if (provider === 'cerebras') {
    const key = process.env.CEREBRAS_API_KEY; if (!key) throw new Error('CEREBRAS_API_KEY ausente — grátis em https://cloud.cerebras.ai');
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, max_tokens: Math.min(tok, 8192), messages: [{ role: 'system', content: system }, ...messages] }) });
    if (!res.ok) throw new Error(`Cerebras ${res.status}`);
    return (await res.json()).choices[0].message.content;
  }
  if (provider === 'openrouter') {
    const key = process.env.OPENROUTER_API_KEY; if (!key) throw new Error('OPENROUTER_API_KEY ausente — grátis em https://openrouter.ai/keys');
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': process.env.NEXIA_APP_URL || 'https://nexiaos.netlify.app', 'X-Title': 'NEXIA OS' }, body: JSON.stringify({ model, max_tokens: tok, messages: [{ role: 'system', content: system }, ...messages] }) });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    return (await res.json()).choices[0].message.content;
  }
  if (['mistral','cohere','nvidia','huggingface','sambanova','together'].includes(provider)) {
    return callFreeProvider(provider, model, system, messages, tok);
  }

  // Fallback chain gratuito
  for (const { k, mk } of [
    { k: 'GROQ_API_KEY', mk: 'groq_llama3' },
    { k: 'DEEPSEEK_API_KEY', mk: 'deepseek_v3' },
    { k: 'GEMINI_API_KEY', mk: 'gemini_20_flash' },
    { k: 'OPENROUTER_API_KEY', mk: 'or_deepseek_v3' },
    { k: 'CEREBRAS_API_KEY', mk: 'cerebras_llama3' },
    { k: 'SAMBANOVA_API_KEY', mk: 'sambanova_llama3' },
    { k: 'TOGETHER_API_KEY', mk: 'together_llama4' }
  ]) {
    if (process.env[k]) return callSync(system, messages, mk, Math.min(tok, 8192));
  }
  throw new Error('Nenhuma API key configurada. Adicione GROQ_API_KEY ou GEMINI_API_KEY no Netlify.');
}

// ═══ IMAGEM ═══════════════════════════════════════════════════════════
async function generateImage(prompt, style) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, error: 'OPENAI_API_KEY não configurada para DALL-E.' };
  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size: '1024x1024', style: style === 'artistic' ? 'vivid' : 'natural', response_format: 'url' }) });
    if (!res.ok) throw new Error(`DALL-E ${res.status}: ${await res.text()}`);
    const d = await res.json();
    return { ok: true, url: d.data[0].url, revised_prompt: d.data[0].revised_prompt };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ═══ SWARM ════════════════════════════════════════════════════════════
async function runSwarm(agentNames, messages, dynAgents) {
  const all = { ...STATIC_AGENTS, ...dynAgents };
  const names = agentNames.filter(n => all[n]);
  if (!names.length) names.push('business');
  const results = await Promise.allSettled(names.map(async name => {
    const agent = all[name];
    const mk = name === 'dev' ? 'groq_deepseek_r1' : name === 'finance' ? 'groq_llama4_maverick' : 'groq_llama4_scout';
    const reply = await callSync(agent.system, messages, mk, 3000);
    return { name, reply, ok: true };
  }));
  const outputs = results.map((r, i) => ({ name: names[i], reply: r.status === 'fulfilled' ? r.value.reply : `[${names[i]} indisponível]`, ok: r.status === 'fulfilled' }));
  if (outputs.filter(o => o.ok).length > 1) {
    const summaryInput = outputs.map(o => `### ${o.name.toUpperCase()}\n${o.reply}`).join('\n\n---\n\n');
    try {
      const synthesis = await callSync('Consolide as análises dos especialistas em uma resposta executiva, estruturada com markdown, em português do Brasil. Seja direto e acionável.', [{ role: 'user', content: summaryInput }], 'groq_llama3', 4000);
      return { outputs, synthesis };
    } catch { }
  }
  return { outputs, synthesis: outputs[0]?.reply || '' };
}

// ═══ PARSER ═══════════════════════════════════════════════════════════
function safeJSON(t) { try { return JSON.parse(t); } catch { return null; } }
function extractJSON(t) { const m = t.match(/\{[\s\S]*\}/); return m ? m[0] : null; }
async function parseOrchestrator(raw) {
  let d = safeJSON(raw); if (d) return { decision: d, layer: 1 };
  const ex = extractJSON(raw); if (ex) { d = safeJSON(ex); if (d) return { decision: d, layer: 2 }; }
  try { const rep = await callSync('Retorne SOMENTE JSON válido. Zero texto fora do JSON.', [{ role: 'user', content: raw }], 'groq_llama3_fast', 600); d = safeJSON(rep) || safeJSON(extractJSON(rep) || ''); if (d) return { decision: d, layer: 3 }; } catch { }
  return { decision: { type: 'chat', intent: 'chat', response: raw }, layer: 'fallback' };
}

// ═══ USAGE ════════════════════════════════════════════════════════════
async function checkAndTrackUsage(tenantId, userId) {
  // SECURITY: Firebase offline → fail-closed (free), NUNCA unlimited
  if (!db) return { ok: true, unlimited: false, plan: 'free', calls: 0, limit: PLAN_LIMITS.free };
  const today = new Date().toISOString().split('T')[0];
  try {
    const tenantDoc = await db.collection('tenants').doc(tenantId).get().catch(() => null);
    const plan = tenantDoc?.exists ? (tenantDoc.data().plan || 'free') : 'free';
    const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
    const ref = db.collection('tenants').doc(tenantId).collection('usage').doc(today);
    const inc = { cortexCalls: admin.firestore.FieldValue.increment(1), [`userBreakdown.${userId}`]: admin.firestore.FieldValue.increment(1) };
    if (limit === -1) {
      const doc = await ref.get();
      if (!doc.exists) await ref.set({ date: today, cortexCalls: 1, tenantId, plan, userBreakdown: { [userId]: 1 } });
      else await ref.update(inc).catch(() => {});
      return { ok: true, unlimited: true, plan, calls: 0, limit: -1 };
    }
    return await db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      if (!doc.exists) { tx.set(ref, { date: today, cortexCalls: 1, tenantId, plan, userBreakdown: { [userId]: 1 } }); return { ok: true, calls: 1, limit, plan }; }
      const calls = (doc.data().cortexCalls || 0) + 1;
      if (calls > limit) return { ok: false, error: `Limite diário do plano **${plan}** atingido (${limit} msgs/dia).\n\nFaça upgrade em **Configurações → Assinatura**.`, calls: doc.data().cortexCalls, limit, plan };
      tx.update(ref, inc);
      return { ok: true, calls, limit, plan };
    });
  } catch (e) { console.warn('[CORTEX] Usage:', e.message); return { ok: true, plan: 'unknown', calls: 0, limit: -1 }; }
}

function buildSystemPrompt(tenantId, plan, ragCtx, learningCtx) {
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const unlimited = plan === 'master' || plan === 'enterprise';
  return `Você é o CORTEX — IA Suprema do NEXIA OS, sistema operacional empresarial SaaS.\n\nTENANT: ${tenantId} | PLANO: ${plan.toUpperCase()} | ACESSO: ${unlimited ? '🔓 ILIMITADO' : plan} | HORA BRT: ${now}\n\n## CAPACIDADES:\n- **Estratégia e Negócios**: SaaS, MRR, churn, pricing, vendas, marketing, valuation\n- **Desenvolvimento**: Firebase, Netlify Functions, JS/TS, React, Python — código COMPLETO\n- **Segurança**: OWASP, LGPD, Firebase Rules, pentest, auditoria\n- **CRM**: Criar tarefas, contatos, reuniões, lançamentos financeiros\n- **Jurídico**: Contratos, LGPD, editais de leilão, compliance\n- **Análise Financeira**: DRE, fluxo de caixa, precificação, projeções\n\n## REGRAS ABSOLUTAS:\n- Responda SEMPRE em português do Brasil\n- Use markdown rico (tabelas, código, listas) em respostas técnicas\n- Forneça código COMPLETO (nunca truncado com "...")\n- Seja direto e acionável — sem rodeios\n${unlimited ? '- Modo MASTER: detalhamento máximo, sem restrições de tamanho\n' : ''}${learningCtx ? `\n## CONTEXTO DO USUÁRIO:\n${learningCtx}\n` : ''}${ragCtx ? `\n## DOCUMENTOS DE REFERÊNCIA:\n${ragCtx}\n` : ''}`;
}

function getStream(ai, system, messages, maxTok) {
  const { provider, model } = ai;
  if (provider === 'anthropic')  return streamAnthropic(system, messages, model, maxTok);
  if (provider === 'openai')     return streamOpenAI(system, messages, model, maxTok);
  if (provider === 'groq')       return streamGroq(system, messages, model, maxTok);
  if (provider === 'perplexity') return streamPerplexity(system, messages, model, maxTok);
  if (provider === 'gemini')     return streamGemini(system, messages, model, maxTok);
  if (provider === 'cerebras')   return streamCerebras(system, messages, model, maxTok);
  if (provider === 'openrouter') return streamOpenRouter(system, messages, model, maxTok);
  return null; // outros providers usam callSync
}

async function cxLog(tenantId, userId, data) {
  if (!db) return;
  try { await db.collection('tenants').doc(tenantId).collection('cortex_logs').add({ ttl: admin.firestore.Timestamp.fromMillis(Date.now() + 2592000000), userId, ...data, ts: admin.firestore.FieldValue.serverTimestamp() }); } catch { }
}

// ═══════════════════════════════════════════════════════════════════════
//  HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════
exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const guardErr = await guard(event, 'cortex-chat');
  if (guardErr) return guardErr;

  const start = Date.now();
  try {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido no body' }) }; }

    const { userId, message: rawMessage, tenantId = 'nexia', ragEnabled = false, model = 'auto', conversationId = 'default', stream = true, image_request, maxTokens = 0 } = body;

    if (!rawMessage) return { statusCode: 400, headers, body: JSON.stringify({ error: 'message é obrigatório' }) };
    const effectiveUserId = userId || 'anon';

    let message;
    try { message = sanitizePrompt(rawMessage); }
    catch (se) { return { statusCode: 400, headers, body: JSON.stringify({ error: se.message }) }; }

    const usage = await checkAndTrackUsage(tenantId, effectiveUserId);
    if (!usage.ok) return { statusCode: 429, headers, body: JSON.stringify({ error: usage.error, plan: usage.plan, limit: usage.limit, calls: usage.calls }) };

    if (image_request?.prompt) {
      const r = await generateImage(image_request.prompt, image_request.style);
      return { statusCode: 200, headers, body: JSON.stringify({ type: 'image', ...r }) };
    }

    let mem = { history: [], summaries: [], entities: {} };
    try { mem = await memModule.load(effectiveUserId, tenantId, conversationId); } catch { }
    const context = typeof memModule.buildContext === 'function' ? memModule.buildContext(mem.history, mem.summaries, 30) : (mem.history || []).slice(-30);
    const learningCtx = await learnModule.buildLearningContext(tenantId, message).catch(() => null);
    let ragCtx = '';
    if (ragEnabled) { try { ragCtx = await ragModule.buildRAGContext(tenantId, message) || ''; } catch { } }

    const fullCtx = [...context, { role: 'user', content: message }];

    let decision = { type: 'chat', intent: model !== 'auto' ? model : 'chat', response: '' };
    let layer = 0;
    if (model === 'auto') {
      try {
        // Orchestrator com fallback multi-provider
        let orchRaw = null;
        const orchModels = ['groq_llama3_fast','gemini_20_flash','deepseek_v3','groq_llama4_scout'];
        for (const om of orchModels) {
          try {
            orchRaw = await callSync(STATIC_AGENTS.orchestrator.system, fullCtx.slice(-12), om, 600);
            if (orchRaw) break;
          } catch { }
        }
        if (orchRaw) {
          const p = await parseOrchestrator(orchRaw);
          decision = p.decision; layer = p.layer;
        }
      } catch (e) { console.warn('[CORTEX] Orchestrator:', e.message); }
    } else { decision.intent = model; }

    if (process.env.NODE_ENV !== 'production') console.warn(`[CORTEX v16] type:${decision.type} intent:${decision.intent} tenant:${tenantId} plan:${usage.plan}`);

    let finalResponse = '', modelUsed = 'groq_llama4_scout', execActions = [], swarmOut = [];

    // 1. AÇÕES CRM
    if (Array.isArray(decision.actions) && decision.actions.length) {
      const role = event._role || 'user';
      for (const act of decision.actions) {
        try {
          if (!act.type || !act.data) continue;
          validateAIAction(act.type, act.data);
          if (!checkPermission(role, act.type)) { execActions.push({ ok: false, action: act.type, error: 'Sem permissão' }); continue; }
          execActions.push(await actionModule.dispatch(act.type, act.data, tenantId, userId));
        } catch (e) { execActions.push({ ok: false, error: e.message, action: act.type }); }
      }
      const lines = execActions.map(r => r.ok ? `✅ \`${r.action}\` executado` : `⚠️ \`${r.action || 'ação'}\` falhou: ${r.error}`).join('\n');
      finalResponse = (decision.response || '') + (lines ? '\n\n' + lines : '');
    }

    // 2. SWARM
    if (decision.type === 'swarm' && Array.isArray(decision.agents) && decision.agents.length) {
      let dynAgents = {};
      if (db) {
        try {
          const snap = await db.collection('agents').where('tenantId', '==', tenantId).where('active', '!=', false).get();
          snap.docs.forEach(d => { const x = d.data(); if (x.systemPrompt) dynAgents[d.id] = { system: x.systemPrompt }; });
        } catch { }
      }
      const sw = await runSwarm(decision.agents, fullCtx.slice(-10), dynAgents);
      swarmOut = sw.outputs;
      finalResponse = (decision.response ? decision.response + '\n\n' : '') + sw.synthesis;
      modelUsed = 'swarm-multi-agent';
    }

    // 3. AUTODEV
    if (!finalResponse.trim() && decision.type === 'code' && decision.code_request && autodevModule) {
      try {
        const r = await autodevModule.handler({ httpMethod: 'POST', body: JSON.stringify(decision.code_request) });
        const b = JSON.parse(r.body);
        finalResponse = r.statusCode === 200 && b.ok ? b.generatedCode : `❌ AutoDev: ${b.error || 'Erro'}`;
        modelUsed = b.modelUsed ? `autodev-${b.modelUsed}` : 'autodev';
      } catch (e) { finalResponse = decision.response || `❌ Erro AutoDev: ${e.message}`; }
    }

    // 4. IMAGEM
    if (!finalResponse.trim() && decision.type === 'image' && decision.image_request) {
      const r = await generateImage(decision.image_request.prompt, decision.image_request.style);
      finalResponse = r.ok ? `🖼️ **Imagem gerada!**\n\n${r.url}\n\n*Prompt: ${r.revised_prompt || decision.image_request.prompt}*` : `❌ Erro imagem: ${r.error}`;
      modelUsed = 'dall-e-3';
    }

    // 5. CHAT COM STREAMING
    if (!finalResponse.trim()) {
      const intentKey = decision.model_override || decision.intent || model || 'auto';
      const resolvedKey = (intentKey === 'auto') ? 'groq_llama4_scout' : (INTENT_ROUTER[intentKey] || intentKey);
      const ai = AI_CATALOG[resolvedKey] || AI_CATALOG.groq_llama3;
      modelUsed = ai.label || ai.model;

      const systemPrompt = buildSystemPrompt(tenantId, usage.plan, ragCtx, learningCtx);
      const tokLimit = maxTokens || (usage.unlimited ? 32000 : 8192);

      if (stream) {
        // Fallback streaming: tenta providers em ordem até um funcionar
        const streamProviderOrder = [
          { key: resolvedKey, ai },
          { key: 'deepseek_v3', ai: AI_CATALOG.deepseek_v3 },
          { key: 'gemini_20_flash', ai: AI_CATALOG.gemini_20_flash },
          { key: 'groq_llama3', ai: AI_CATALOG.groq_llama3 },
          { key: 'gemini_25_flash', ai: AI_CATALOG.gemini_25_flash },
        ];

        let streamSuccess = false;
        for (const sp of streamProviderOrder) {
          const gen = getStream(sp.ai, systemPrompt, fullCtx.slice(-30), tokLimit);
          if (!gen) continue;
          const chunks = []; let fullText = ''; let firstToken = true; let isError = false;
          try {
            for await (const token of gen) {
              // Se primeiro token é aviso de key ausente, tenta próximo provider
              if (firstToken && (token.startsWith('⚠️') || token.startsWith('❌'))) {
                isError = true; firstToken = false;
                console.warn('[CORTEX] Provider', sp.key, 'indisponível, tentando próximo...');
                break;
              }
              firstToken = false;
              chunks.push(`data: ${JSON.stringify({ token, done: false })}\n\n`);
              fullText += token;
            }
            if (isError) continue; // tenta próximo provider
            modelUsed = sp.ai.label || sp.ai.model;
            chunks.push(`data: ${JSON.stringify({ done: true, model: modelUsed, intent: decision.type, actions: execActions, swarm: swarmOut, usage: { calls: usage.calls, limit: usage.limit, unlimited: !!usage.unlimited } })}\n\n`);
            chunks.push('data: [DONE]\n\n');
            const nm = [{ role: 'user', content: message }, { role: 'assistant', content: fullText }];
            if (typeof memModule.save === 'function') memModule.save(userId, [...(mem.history || []), ...nm], mem.summaries, tenantId, memModule.extractEntities ? memModule.extractEntities(nm, mem.entities) : {}, conversationId).catch(() => {});
            cxLog(tenantId, userId, { type: 'cortex_execution', conversationId, intent: decision.type, layer, ms: Date.now() - start, modelUsed, stream: true, plan: usage.plan }).catch(() => {});
            streamSuccess = true;
            return { statusCode: 200, headers: SSE_HEADERS, body: chunks.join('') };
          } catch (err) {
            console.warn('[CORTEX] Stream error on', sp.key, ':', err.message);
            continue; // tenta próximo
          }
        }
        if (!streamSuccess) {
          // Nenhum streaming funcionou — tentar sync como último recurso
          try {
            for (const fm of ['deepseek_v3','gemini_20_flash','groq_llama3']) {
              try { finalResponse = await callSync(systemPrompt, fullCtx.slice(-15), fm, 4096); modelUsed = `sync-fallback:${fm}`; break; } catch { }
            }
          } catch { }
          if (!finalResponse) finalResponse = '❌ Todas as IAs estão indisponíveis. Verifique as API keys no Netlify.';
          return { statusCode: 200, headers: SSE_HEADERS, body: `data: ${JSON.stringify({ token: finalResponse, done: false })}\n\ndata: ${JSON.stringify({ done: true, model: 'fallback' })}\n\ndata: [DONE]\n\n` };
        }
        // código legado abaixo — provider sem streaming nativo
        const gen_legacy = null;
        if (gen_legacy) {
          try { finalResponse = await callSync(systemPrompt, fullCtx.slice(-30), resolvedKey, tokLimit); }
          catch (e) {
            const fallbackChain2 = ['groq_llama4_scout','deepseek_v3','gemini_20_flash','groq_llama3','or_deepseek_v3'];
            let fallbackDone = false;
            for (const fm of fallbackChain2) {
              try { finalResponse = await callSync(systemPrompt, fullCtx.slice(-15), fm, 4096); modelUsed = `fallback:${fm}`; fallbackDone = true; break; } catch { }
            }
            if (!fallbackDone) finalResponse = `❌ Todas as IAs falharam. Configure pelo menos GROQ_API_KEY ou GEMINI_API_KEY no Netlify.\n\nDetalhes do erro anterior: ${e.message}`;
          }
          const nm = [{ role: 'user', content: message }, { role: 'assistant', content: finalResponse }];
          if (typeof memModule.save === 'function') memModule.save(userId, [...(mem.history || []), ...nm], mem.summaries, tenantId, {}, conversationId).catch(() => {});
          return { statusCode: 200, headers: SSE_HEADERS, body: `data: ${JSON.stringify({ token: finalResponse, done: false })}\n\ndata: ${JSON.stringify({ done: true, model: modelUsed, intent: decision.type, actions: execActions, swarm: swarmOut, usage: { calls: usage.calls, limit: usage.limit, unlimited: !!usage.unlimited } })}\n\ndata: [DONE]\n\n` };
        }
      } else {
        try { finalResponse = await callSync(systemPrompt, fullCtx.slice(-30), resolvedKey, tokLimit); }
        catch (e) {
            const fallbackChain3 = ['groq_llama4_scout','deepseek_v3','gemini_20_flash','groq_llama3'];
            let fallDone3 = false;
            for (const fm of fallbackChain3) {
              try { finalResponse = await callSync(systemPrompt, fullCtx.slice(-15), fm, 4096); modelUsed = `fallback:${fm}`; fallDone3 = true; break; } catch { }
            }
            if (!fallDone3) finalResponse = `❌ Falha ao chamar IA: ${e.message}`;
        }
      }
    }

    const nm = [{ role: 'user', content: message }, { role: 'assistant', content: finalResponse }];
    if (typeof memModule.save === 'function') await memModule.save(userId, [...(mem.history || []), ...nm], mem.summaries, tenantId, {}, conversationId).catch(() => {});
    if (typeof learnModule.saveExample === 'function') learnModule.saveExample(tenantId, userId, message, finalResponse, decision.type, conversationId).catch(() => {});
    await cxLog(tenantId, userId, { type: 'cortex_execution', conversationId, intent: decision.type, layer, ms: Date.now() - start, actionsCount: execActions.length, modelUsed, plan: usage.plan }).catch(() => {});

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ reply: finalResponse, type: decision.type, intent: decision.intent, actions: execActions, swarm: swarmOut, _meta: { layer, ms: Date.now() - start, modelUsed, version: 'v16.0', conversationId, plan: usage.plan, unlimited: !!usage.unlimited, usage: { calls: usage.calls, limit: usage.limit } } })
    };

  } catch (err) {
    console.error('[CORTEX v16] ❌', err.message, err.stack);
    const status = err.message?.includes('Limite') ? 429 : err.message?.includes('não permitid') ? 403 : 500;
    return { statusCode: status, headers, body: JSON.stringify({ error: err.message }) };
  }
};
