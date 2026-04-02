'use strict';

/**
/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — CORTEX MEMORY v9.0                      ║
 * ║  Memória isolada por tenant · Sumarização automática ║
 * ║  FIX v9: cortex_memory era global — agora é por     ║
 * ║  tenants/{tenantId}/cortex_memory/{userId}          ║
 * ╚══════════════════════════════════════════════════════╝
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
  console.warn('[NEXIA] Firebase indisponivel:', e.message);
  db = null;
}
const { guard, makeHeaders} = require('./middleware');


const MAX_RAW_MESSAGES  = 30;
const MAX_KEEP_RECENT   = 10;
const MAX_SUMMARIES     = 5;
const MAX_TOTAL_HISTORY = 50;


// ── Sumariza histórico via IA ──────────────────────────────────
async function summarizeHistory(oldMessages) {
  try {
    const text = oldMessages
      .map(m => `${m.role === 'user' ? '👤' : '🤖'} ${m.content}`)
      .join('\n');


    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        temperature: 0,
        max_tokens: 500,
        messages: [
          {
            role: 'system',
            content: 'Você é um sistema de compressão de memória de IA. Resuma o histórico de forma concisa preservando: decisões tomadas, ações executadas, dados importantes de clientes/tarefas/reuniões, contexto do negócio e intenções do usuário. Máximo 350 palavras. Em português.'
          },
          { role: 'user', content: `HISTÓRICO:\n${text}\n\nRESUMO COMPRIMIDO:` }
        ]
      })
    });


    if (!res.ok) return null;
    const data = await res.json();
    return data.choices[0].message.content;
  } catch {
    return null;
  }
}


// ── Classifica tipo de mensagem ────────────────────────────────
function classifyMessage(content) {
  if (!content) return 'chat';
  const c = content.toLowerCase();
  if (c.includes('✅') || c.includes('criado') || c.includes('executad') || c.includes('atualizado')) return 'action';
  if (c.includes('```') || c.includes('function') || c.includes('código') || c.includes('const ')) return 'dev';
  if (c.includes('r$') || c.includes('receita') || c.includes('despesa') || c.includes('financ')) return 'finance';
  if (c.includes('reunião') || c.includes('meeting') || c.includes('agendar')) return 'meeting';
  return 'chat';
}


// ── Rota de storage isolada por tenant ────────────────────────
function memRef(tenantId, userId, conversationId = 'default') {
  return db.collection("tenants").doc(tenantId)
    .collection("cortex_memory").doc(`${userId}_${conversationId}`);
}


// ── Carrega memória ────────────────────────────────────────────
async function load(userId, tenantId = 'nexia', conversationId = 'default') {
  try {
    const doc = await memRef(tenantId, userId, conversationId).get();
    if (!doc.exists) return { history: [], summaries: [], stats: {}, entities: {} };
    return {
      history:   doc.data().history   || [],
      summaries: doc.data().summaries || [],
      stats:     doc.data().stats     || {},
      entities:  doc.data().entities  || {}  // clientes, tarefas mencionadas
    };
  } catch (e) {
    console.error('[CORTEX-MEMORY] load error:', e.message);
    return { history: [], summaries: [], stats: {}, entities: {} };
  }
}


// ── Salva memória com sumarização automática ───────────────────
async function save(userId, history, existingSummaries = [], tenantId = 'nexia', entities = {}, conversationId = 'default') {
  let summaries = [...existingSummaries];


  if (history.length > MAX_RAW_MESSAGES) {
    const toSummarize = history.slice(0, history.length - MAX_KEEP_RECENT);
    const recent      = history.slice(history.length - MAX_KEEP_RECENT);


    const summary = await summarizeHistory(toSummarize);
    if (summary) {
      summaries.push({
        content:   summary,
        createdAt: new Date().toISOString(),
        msgCount:  toSummarize.length
      });
      if (summaries.length > MAX_SUMMARIES) summaries = summaries.slice(-MAX_SUMMARIES);
      history = recent;
    } else {
      history = history.slice(-MAX_KEEP_RECENT);
    }
  }


  if (history.length > MAX_TOTAL_HISTORY) history = history.slice(-MAX_TOTAL_HISTORY);


  const stats = {
    totalMessages:   history.length,
    totalSummaries:  summaries.length,
    lastUpdated:     new Date().toISOString(),
    messageTypes:    history.reduce((acc, m) => {
      const t = classifyMessage(m.content);
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {})
  };


  await memRef(tenantId, userId, conversationId).set({
    history,
    summaries,
    stats,
    entities,
    tenantId,
    userId,
    updatedAt: new Date().toISOString()
  });


  return { history, summaries, stats, entities };
}


// ── Extrai entidades mencionadas (clientes, tarefas, etc) ─────
function extractEntities(messages, existingEntities = {}) {
  const entities = { ...existingEntities };
  for (const m of messages) {
    if (!m.content) continue;
    // Detecta IDs de recursos nas respostas do assistente
    const idMatches = m.content.matchAll(/`?(createClient|createTask|createMeeting|createFinance)`?.+?ID[:\s]+`?([A-Za-z0-9]{15,30})`?/g);
    for (const match of idMatches) {
      const [, type, id] = match;
      const key = type.replace('create', '').toLowerCase() + 's';
      if (!entities[key]) entities[key] = [];
      if (!entities[key].includes(id)) entities[key].push(id);
      // Mantém só os últimos 10 por tipo
      if (entities[key].length > 10) entities[key] = entities[key].slice(-10);
    }
  }
  return entities;
}


// ── Monta contexto completo para enviar à IA ──────────────────
function buildContext(history, summaries, maxRecent = 20) {
  const recent = history.slice(-maxRecent);
  if (!summaries.length) return recent;


  const summaryText = summaries
    .map((s, i) => `[Resumo ${i + 1} — ${s.msgCount} mensagens anteriores]:\n${s.content}`)
    .join('\n\n');


  return [
    { role: 'system', content: `MEMÓRIA COMPRIMIDA (contexto anterior do usuário):\n${summaryText}` },
    ...recent
  ];
}


// ── Deleta memória de um usuário ───────────────────────────────
async function clear(userId, tenantId = 'nexia', conversationId = 'default') {
  await memRef(tenantId, userId, conversationId).delete();
  return { ok: true, cleared: true };
}


// ── Handler Netlify ────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };


  const guardErr = await guard(event, 'cortex-memory', { skipTenant: true });
  if (guardErr) return guardErr;


  try {
    const { userId, tenantId = 'nexia', messages, action, conversationId = 'default' } = JSON.parse(event.body || '{}');
    if (!userId) throw new Error('userId é obrigatório');


    const mem = await load(userId, tenantId, conversationId);


    if (action === 'get') {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          history:   mem.history,
          summaries: mem.summaries,
          stats:     mem.stats,
          entities:  mem.entities,
          context:   buildContext(mem.history, mem.summaries)
        })
      };
    }


    if (action === 'clear') {
      const result = await clear(userId, tenantId, conversationId);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }


    if (!Array.isArray(messages)) throw new Error('messages[] é obrigatório');
    const updated  = [...mem.history, ...messages];
    const entities = extractEntities(messages, mem.entities);
    const result   = await save(userId, updated, mem.summaries, tenantId, entities, conversationId);


    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true,
        total:     result.history.length,
        summaries: result.summaries.length,
        stats:     result.stats,
        entities:  result.entities
      })
    };


  } catch (err) {
    console.error('[CORTEX-MEMORY] ❌', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};


exports.load         = load;
exports.save         = save;
exports.clear        = clear;
exports.buildContext = buildContext;
exports.extractEntities = extractEntities;
