'use strict';
const _fetch = globalThis.fetch.bind(globalThis); // Node 20+ native fetch
const { guard, HEADERS, makeHeaders } = require('./middleware');

const MODELS = {
  groq_llama3:       { id: 'llama3-70b-8192',             provider: 'groq' },
  groq_mixtral:      { id: 'mixtral-8x7b-32768',          provider: 'groq' },
  groq_llama3_fast:  { id: 'llama-3.1-8b-instant',        provider: 'groq' },
  deepseek_chat:     { id: 'deepseek-chat',                provider: 'deepseek' },
  deepseek_coder:    { id: 'deepseek-coder',               provider: 'deepseek' },
  openai_gpt4o:      { id: 'gpt-4o',                      provider: 'openai' },
  openai_gpt4_mini:  { id: 'gpt-4o-mini',                 provider: 'openai' },
  gemini:            { id: 'gemini-2.0-flash',             provider: 'gemini' },
  gpt4o:             { id: 'gpt-4o',                      provider: 'openai' },
  grok3:             { id: 'grok-3-fast',                 provider: 'xai' },
  anthropic:         { id: 'claude-sonnet-4-5',            provider: 'anthropic' },
  claude_sonnet:     { id: 'claude-sonnet-4-5',            provider: 'anthropic' },
  claude_opus:       { id: 'claude-opus-4-5',              provider: 'anthropic' },
};

async function callModelAnthropic(modelId, messages, options = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY não configurado. Adicione nas variáveis de ambiente da Netlify.');

  const systemMsg = messages.find(m => m.role === 'system');
  const userMessages = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role, content: m.content
  }));

  const body = {
    model: modelId,
    max_tokens: options.max_tokens || 4096,
    messages: userMessages
  };
  if (systemMsg) body.system = systemMsg.content;
  if (options.temperature !== undefined) body.temperature = options.temperature;

  const res = await _fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Anthropic API error');
  return data.content?.[0]?.text || '';
}

async function callModel(modelKey, messages, options = {}) {
  const model = MODELS[modelKey];
  if (!model) throw new Error(`Modelo desconhecido: "${modelKey}". Disponíveis: ${Object.keys(MODELS).join(', ')}`);
  const { provider, id } = model;

  if (provider === 'anthropic') return callModelAnthropic(id, messages, options);

  if (provider === 'gemini') {
    const gemKey = process.env.GEMINI_API_KEY;
    if (!gemKey) throw new Error('GEMINI_API_KEY não configurado.');
    const gemUrl = `https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent?key=${gemKey}`;
    const systemMsg = messages.find(m => m.role === 'system');
    const userMessages = messages.filter(m => m.role !== 'system');
    const bodyG = {
      contents: userMessages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { temperature: options.temperature ?? 0.7, maxOutputTokens: options.max_tokens ?? 2000 }
    };
    if (systemMsg) bodyG.systemInstruction = { parts: [{ text: systemMsg.content }] };
    const res = await _fetch(gemUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyG) });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Gemini API error');
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  let url, key;
  if (provider === 'groq')     { url = 'https://api.groq.com/openai/v1/chat/completions';   key = process.env.GROQ_API_KEY; }
  else if (provider === 'deepseek') { url = 'https://api.deepseek.com/v1/chat/completions'; key = process.env.DEEPSEEK_API_KEY; }
  else if (provider === 'openai')   { url = 'https://api.openai.com/v1/chat/completions';   key = process.env.OPENAI_API_KEY; }
  else if (provider === 'xai')      { url = 'https://api.x.ai/v1/chat/completions';         key = process.env.XAI_API_KEY; }
  else throw new Error(`Provider desconhecido: ${provider}`);

  if (!key) throw new Error(`Variável de ambiente ausente para provider "${provider}". Configure a chave na Netlify.`);
  const res = await _fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: id, messages, temperature: options.temperature ?? 0.7, max_tokens: options.max_tokens ?? 2000 })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || `${provider} API error`);
  return data.choices[0].message.content;
}

exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    const g = await guard(event, 'multi-model-engine');
  if (g) return g;
  try {
    const { action, messages, model = 'groq_llama3', options = {} } = JSON.parse(event.body || '{}');
    if (action === 'call') {
      const reply = await callModel(model, messages, options);
      return { statusCode: 200, headers, body: JSON.stringify({ reply, modelUsed: model }) };
    }
    if (action === 'list') {
      return { statusCode: 200, headers, body: JSON.stringify({ models: Object.keys(MODELS) }) };
    }
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action' }) };
  } catch (err) { return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }; }
};
exports.callModel = callModel;
