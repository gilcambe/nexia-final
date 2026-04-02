'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS — CHURN PREDICTOR v1.0                            ║
 * ║  Predição de churn por tenant com scoring heurístico        ║
 * ║  + recomendações de retenção via IA (Groq)                  ║
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
} catch (e) { console.warn('[CHURN] Firebase indisponivel:', e.message); db = null; }

const { guard, HEADERS, makeHeaders } = require('./middleware');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  const auth = await guard(event, 'churn-predictor');
  if (auth) return auth; // guard retorna objeto de erro ou null se ok

  const params = event.queryStringParameters || {};
  const tenantId = params.tenantId;
  const withAI = params.ai !== 'false';

  try {
    if (tenantId) {
      const result = await predictTenant(tenantId, withAI);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }
    const allResults = await predictAll();
    return { statusCode: 200, headers, body: JSON.stringify(allResults) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

async function predictTenant(tenantId, withAI = true) {
  if (!db) return { error: 'Firebase não configurado' };

  const doc = await db.collection('tenants').doc(tenantId).get();
  if (!doc.exists) return { error: 'Tenant não encontrado' };
  const t = { id: doc.id, ...doc.data() };

  const signals = await collectSignals(t);
  const score = calcChurnScore(signals);
  const label = score >= 70 ? 'ALTO' : score >= 40 ? 'MÉDIO' : 'BAIXO';
  const color = score >= 70 ? 'red' : score >= 40 ? 'amber' : 'green';

  let aiRecommendation = null;
  if (withAI && process.env.GROQ_API_KEY) {
    aiRecommendation = await getAIRecommendation(t, signals, score);
  }

  const result = { tenantId, name: t.name || tenantId, churnScore: score, riskLevel: label, color, signals, aiRecommendation, analyzedAt: new Date().toISOString() };

  // Salva no Firestore
  try {
    await db.collection('churn_predictions').add({ ...result, ts: admin.firestore.FieldValue.serverTimestamp() });
    await db.collection('tenants').doc(tenantId).update({ churnScore: score, churnRisk: label, lastChurnCheck: admin.firestore.FieldValue.serverTimestamp() });
  } catch {}

  return result;
}

async function predictAll() {
  if (!db) return { predictions: [], summary: { high: 0, medium: 0, low: 0 } };

  const snap = await db.collection('tenants').where('status', 'in', ['active', 'ativo']).get();
  const predictions = [];
  let high = 0, medium = 0, low = 0;

  // Processa em batches de 5 para não explodir o timeout
  const tenants = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  for (const t of tenants) {
    const signals = await collectSignals(t);
    const score = calcChurnScore(signals);
    const label = score >= 70 ? 'ALTO' : score >= 40 ? 'MÉDIO' : 'BAIXO';
    predictions.push({ tenantId: t.id, name: t.name || t.id, churnScore: score, riskLevel: label });
    if (label === 'ALTO') high++;
    else if (label === 'MÉDIO') medium++;
    else low++;
    // Atualiza no Firestore
    try { await db.collection('tenants').doc(t.id).update({ churnScore: score, churnRisk: label }); } catch {}
  }

  return {
    predictions: predictions.sort((a, b) => b.churnScore - a.churnScore),
    summary: { high, medium, low, total: predictions.length }
  };
}

async function collectSignals(tenant) {
  const now = Date.now();
  const signals = {
    daysSinceLastActivity: 999,
    cortexCallsLast30d: 0,
    paymentOverdue: false,
    trialExpiringSoon: false,
    planIsFree: false,
    supportTicketsOpen: 0,
    loginFrequency: 0,
    featureAdoption: 0
  };

  // Última atividade
  if (tenant.lastActivity?.seconds) {
    signals.daysSinceLastActivity = Math.round((now - tenant.lastActivity.seconds * 1000) / 86400000);
  }

  // Plano free
  signals.planIsFree = (tenant.plan || tenant.subscription?.plan || 'free') === 'free';

  // Pagamento em atraso
  signals.paymentOverdue = tenant.paymentStatus === 'overdue' || tenant.subscription?.status === 'overdue';

  // Trial expirando (< 7 dias)
  if (tenant.trialEnd?.seconds) {
    const daysLeft = Math.round((tenant.trialEnd.seconds * 1000 - now) / 86400000);
    signals.trialExpiringSoon = daysLeft > 0 && daysLeft < 7;
  }

  // Uso do Cortex nos últimos 30 dias
  if (db) {
    try {
      const usageSnap = await db.collection('data').doc(tenant.id)
        .collection('usage').orderBy('date', 'desc').limit(30).get();
      usageSnap.forEach(d => { signals.cortexCallsLast30d += d.data().cortexCalls || 0; });
    } catch {}

    // Tickets abertos
    try {
      const ticketsSnap = await db.collection('data').doc(tenant.id)
        .collection('support_tickets').where('status', '==', 'open').get();
      signals.supportTicketsOpen = ticketsSnap.size;
    } catch {}
  }

  return signals;
}

function calcChurnScore(signals) {
  let score = 0;

  // Inatividade (peso: 35)
  if (signals.daysSinceLastActivity > 30) score += 35;
  else if (signals.daysSinceLastActivity > 14) score += 20;
  else if (signals.daysSinceLastActivity > 7) score += 10;

  // Baixo uso do Cortex (peso: 25)
  if (signals.cortexCallsLast30d === 0) score += 25;
  else if (signals.cortexCallsLast30d < 5) score += 15;
  else if (signals.cortexCallsLast30d < 20) score += 5;

  // Pagamento em atraso (peso: 30)
  if (signals.paymentOverdue) score += 30;

  // Trial expirando (peso: 20)
  if (signals.trialExpiringSoon) score += 20;

  // Plano free (peso: 15)
  if (signals.planIsFree) score += 15;

  // Tickets abertos sem resposta (peso: 10)
  if (signals.supportTicketsOpen > 2) score += 10;
  else if (signals.supportTicketsOpen > 0) score += 5;

  return Math.min(100, score);
}

async function getAIRecommendation(tenant, signals, score) {
  try {
    const prompt = `Tenant: ${tenant.name || tenant.id}
Plano: ${tenant.plan || 'free'}
Churn Score: ${score}/100
Sinais:
- Dias sem atividade: ${signals.daysSinceLastActivity}
- Calls Cortex/30d: ${signals.cortexCallsLast30d}
- Pagamento atrasado: ${signals.paymentOverdue}
- Trial expirando: ${signals.trialExpiringSoon}

Gere 3 ações específicas de retenção em PT-BR. Formato JSON:
{"actions": ["ação 1", "ação 2", "ação 3"], "urgency": "imediata|esta semana|este mês", "template_email": "assunto: ...\n\ncorpo: ..."}`;

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 400,
        messages: [
          { role: 'system', content: 'Você é um especialista em customer success SaaS. Responda APENAS em JSON válido.' },
          { role: 'user', content: prompt }
        ]
      })
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch { return null; }
}
