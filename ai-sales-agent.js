'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS — AI SALES AGENT v1.0                             ║
 * ║  Agente de vendas para landing pages (omnichannel)          ║
 * ║  Qualifica leads, agenda demos, envia para CRM              ║
 * ╚══════════════════════════════════════════════════════════════╝
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
} catch (e) { console.warn('[SALES] Firebase indisponivel:', e.message); db = null; }

const { HEADERS, makeHeaders, requireBearerAuth } = require('./middleware');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const SALES_SYSTEM = (tenantConfig) => `Você é ${tenantConfig.agentName || 'ARIA'}, a consultora de IA da ${tenantConfig.companyName || 'NEXIA'}.

PERSONALIDADE: Consultiva, empática, direta. Foco em valor, não em features.
IDIOMA: Sempre português brasileiro.
OBJETIVO: Qualificar o lead e agendar uma demonstração.

SOBRE A EMPRESA:
${tenantConfig.pitch || 'Somos uma plataforma SaaS de IA que automatiza operações empresariais.'}

PLANOS:
${tenantConfig.plans || '- Starter (R$ 297/mês): até 3 usuários\n- Pro (R$ 597/mês): até 10 usuários\n- Enterprise (R$ 1.497/mês): ilimitado'}

FLUXO DE QUALIFICAÇÃO:
1. Entender o problema/dor do lead
2. Apresentar solução relevante (não listar features)
3. Qualificar: tamanho da empresa, orçamento, urgência
4. Propor próximo passo: demo de 30 min, trial gratuito, ou proposta

DADOS QUE VOCÊ DEVE COLETAR (de forma natural, não robotizada):
- Nome e empresa
- Problema principal
- Número de funcionários
- Decisor ou influenciador?

REGRAS:
- Nunca invente preços ou features que não existam
- Se não souber algo: "Vou verificar isso com nossa equipe e te retorno"
- Sempre ofereça um próximo passo claro
- Máximo 3 perguntas por mensagem
- Respostas curtas (3-4 linhas) a menos que perguntado para detalhar

AÇÕES DISPONÍVEIS (use quando coletar dados suficientes):
Para criar lead: <action>{"type":"create_lead","data":{...}}</action>
Para agendar demo: <action>{"type":"schedule_demo","data":{...}}</action>`;

exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  // CORRIGIDO v38: requireBearerAuth
    const _aErr = await requireBearerAuth(event);
  if (_aErr) return _aErr;
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido' }) }; }

  const { tenantId = 'nexia', message, sessionId, history = [], stream = false } = body;

  if (!message?.trim()) return { statusCode: 400, headers, body: JSON.stringify({ error: 'message obrigatório' }) };

  // Carrega config do tenant
  const tenantConfig = await getTenantConfig(tenantId);

  // Monta histórico
  const messages = [
    ...history.slice(-10), // últimas 10 trocas
    { role: 'user', content: message.trim() }
  ];

  try {
    const response = await callAI(messages, tenantConfig);

    // Extrai ações do response
    const actions = extractActions(response);

    // Executa ações (cria lead, agenda demo)
    const actionResults = [];
    for (const action of actions) {
      const result = await executeAction(action, tenantId, sessionId);
      actionResults.push(result);
    }

    // Limpa response (remove tags de action)
    const cleanResponse = response.replace(/<action>[\s\S]*?<\/action>/g, '').trim();

    // Salva histórico da conversa
    if (db && sessionId) {
      await saveConversation(tenantId, sessionId, message, cleanResponse, actions);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply: cleanResponse,
        actions: actionResults,
        sessionId: sessionId || generateId(),
        agent: tenantConfig.agentName || 'ARIA',
        avatar: tenantConfig.agentAvatar || null
      })
    };
  } catch (e) {
    console.error('[SALES] Error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

async function callAI(messages, tenantConfig) {
  // Tenta Groq primeiro (mais rápido), fallback Claude
  const groqKey = process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (groqKey) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 600,
        temperature: 0.7,
        messages: [{ role: 'system', content: SALES_SYSTEM(tenantConfig) }, ...messages]
      })
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    }
  }

  if (anthropicKey) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: SALES_SYSTEM(tenantConfig),
        messages
      })
    });
    if (res.ok) {
      const data = await res.json();
      return data.content?.[0]?.text || '';
    }
  }

  throw new Error('Nenhuma API de IA disponível');
}

async function getTenantConfig(tenantId) {
  const defaults = {
    agentName: 'ARIA',
    companyName: 'NEXIA',
    pitch: 'NEXIA é uma plataforma de IA que automatiza vendas, CRM, financeiro e operações para empresas.',
    plans: '- Starter R$ 297/mês\n- Pro R$ 597/mês\n- Enterprise R$ 1.497/mês'
  };

  if (!db) return defaults;
  try {
    const doc = await db.collection('tenants').doc(tenantId)
      .collection('config').doc('sales_agent').get();
    if (doc.exists) return { ...defaults, ...doc.data() };
  } catch {}
  return defaults;
}

function extractActions(text) {
  const actions = [];
  const regex = /<action>([\s\S]*?)<\/action>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try { actions.push(JSON.parse(match[1])); } catch {}
  }
  return actions;
}

async function executeAction(action, tenantId, sessionId) {
  if (!db) return { type: action.type, status: 'skipped', reason: 'Firebase indisponível' };

  try {
    if (action.type === 'create_lead') {
      const leadData = {
        ...action.data,
        origem: 'sales_agent',
        sessionId,
        status: 'Novo',
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      };
      const ref = await db.collection('data').doc(tenantId)
        .collection('leads').add(leadData);

      // Audit log
      await db.collection('data').doc(tenantId).collection('audit_logs').add({
        acao: 'LEAD_CRIADO', modulo: 'SalesAgent', leadId: ref.id,
        ts: admin.firestore.FieldValue.serverTimestamp()
      });
      return { type: 'create_lead', status: 'ok', leadId: ref.id };
    }

    if (action.type === 'schedule_demo') {
      const demoData = {
        ...action.data,
        tipo: 'demo',
        status: 'agendado',
        origem: 'sales_agent',
        sessionId,
        ts: admin.firestore.FieldValue.serverTimestamp()
      };
      const ref = await db.collection('data').doc(tenantId)
        .collection('agendamentos').add(demoData);
      return { type: 'schedule_demo', status: 'ok', agendamentoId: ref.id };
    }
  } catch (e) {
    return { type: action.type, status: 'error', error: e.message };
  }
  return { type: action.type, status: 'unknown' };
}

async function saveConversation(tenantId, sessionId, userMsg, botMsg, actions) {
  if (!db) return;
  try {
    const ref = db.collection('data').doc(tenantId)
      .collection('sales_sessions').doc(sessionId);
    await ref.set({
      tenantId, lastActivity: admin.firestore.FieldValue.serverTimestamp(),
      messageCount: admin.firestore.FieldValue.increment(1)
    }, { merge: true });
    await ref.collection('messages').add({
      user: userMsg, bot: botMsg, actions,
      ts: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch {}
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
