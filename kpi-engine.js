'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS — KPI ENGINE v1.0                                  ║
 * ║  MRR, ARR, LTV, Churn Rate, CAC, NRR — dados reais          ║
 * ║  Calculado ao vivo do Firestore + cache 1h                   ║
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
} catch (e) {
  console.warn('[KPI] Firebase indisponivel:', e.message);
  db = null;
}

const { guard, HEADERS, makeHeaders } = require('./middleware');

const PLAN_MRR = { free: 0, starter: 297, pro: 597, business: 997, enterprise: 1497, master: 0 };
const CACHE_TTL = 3600000; // 1h em ms
let _cache = null, _cacheTs = 0;

exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const auth = await guard(event, 'kpi-engine');
  if (auth) return auth; // guard retorna objeto de erro ou null se ok

  const params = event.queryStringParameters || {};
  const action = params.action || 'summary';
  const tenantId = params.tenantId || null;
  const forceRefresh = params.refresh === 'true';

  try {
    if (action === 'summary') {
      const kpis = await getKPIs(forceRefresh);
      return { statusCode: 200, headers, body: JSON.stringify(kpis) };
    }
    if (action === 'tenant' && tenantId) {
      const kpis = await getTenantKPIs(tenantId);
      return { statusCode: 200, headers, body: JSON.stringify(kpis) };
    }
    if (action === 'churn') {
      const churn = await getChurnMetrics();
      return { statusCode: 200, headers, body: JSON.stringify(churn) };
    }
    if (action === 'cohort') {
      const cohort = await getCohortData();
      return { statusCode: 200, headers, body: JSON.stringify(cohort) };
    }
    if (action === 'mrr_timeline') {
      const timeline = await getMRRTimeline();
      return { statusCode: 200, headers, body: JSON.stringify(timeline) };
    }
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'action inválida' }) };
  } catch (e) {
    console.error('[KPI] Error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

async function getKPIs(forceRefresh = false) {
  // Cache hit
  if (!forceRefresh && _cache && Date.now() - _cacheTs < CACHE_TTL) return _cache;
  if (!db) return getMockKPIs();

  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastMonth = (() => {
    const d = new Date(now); d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();

  // Busca todos os tenants ativos
  const tenantsSnap = await db.collection('tenants').get();
  const tenants = tenantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  let mrr = 0, mrrLastMonth = 0, activeTenants = 0, churnedThisMonth = 0;
  let newThisMonth = 0, totalLifetimeRevenue = 0;
  const tenantMRRs = [];

  for (const t of tenants) {
    const plan = t.subscription?.plan || t.plan || 'free';
    const planMRR = t.mrr || PLAN_MRR[plan] || 0;
    const status = t.status || 'active';
    const createdMonth = t.createdAt ? new Date(t.createdAt.seconds * 1000).toISOString().slice(0, 7) : null;
    const cancelledMonth = t.cancelledAt ? new Date(t.cancelledAt.seconds * 1000).toISOString().slice(0, 7) : null;

    if (status === 'active' || status === 'ativo') {
      mrr += planMRR;
      activeTenants++;
      tenantMRRs.push({ id: t.id, name: t.name || t.id, mrr: planMRR, plan });
      if (createdMonth === thisMonth) newThisMonth++;
    }
    if (cancelledMonth === thisMonth) churnedThisMonth++;

    // LTV estimado: MRR × vida média (18 meses)
    const ageMonths = createdMonth
      ? Math.max(1, Math.round((now - new Date(createdMonth + '-01')) / 2592000000))
      : 1;
    totalLifetimeRevenue += planMRR * ageMonths;
  }

  // MRR mês passado — lê do cache de métricas
  try {
    const snapLast = await db.collection('empire_metrics')
      .where('month', '==', lastMonth).orderBy('ts', 'desc').limit(1).get();
    if (!snapLast.empty) mrrLastMonth = snapLast.docs[0].data().mrr || 0;
  } catch {}

  const arr = mrr * 12;
  const ltv = activeTenants > 0 ? Math.round(totalLifetimeRevenue / tenants.length) : 0;
  const churnRate = activeTenants > 0
    ? parseFloat(((churnedThisMonth / (activeTenants + churnedThisMonth)) * 100).toFixed(1))
    : 0;
  const mrrGrowth = mrrLastMonth > 0
    ? parseFloat((((mrr - mrrLastMonth) / mrrLastMonth) * 100).toFixed(1))
    : 0;
  const nrr = mrrLastMonth > 0
    ? parseFloat(((mrr / mrrLastMonth) * 100).toFixed(1))
    : 100;
  const cac = mrr > 0 ? Math.round(mrr * 0.3 / Math.max(newThisMonth, 1)) : 0;

  // Salva snapshot no Firestore
  const snap = {
    mrr, arr, ltv, churnRate, mrrGrowth, nrr, cac,
    activeTenants, newThisMonth, churnedThisMonth,
    month: thisMonth,
    ts: admin.firestore.FieldValue.serverTimestamp(),
    topTenants: tenantMRRs.sort((a, b) => b.mrr - a.mrr).slice(0, 5)
  };
  try { await db.collection('empire_metrics').add(snap); } catch {}

  _cache = snap;
  _cacheTs = Date.now();
  return snap;
}

async function getTenantKPIs(tenantId) {
  if (!db) return {};
  const doc = await db.collection('tenants').doc(tenantId).get();
  if (!doc.exists) return { error: 'tenant não encontrado' };
  const t = doc.data();
  const plan = t.subscription?.plan || t.plan || 'free';
  const planMRR = t.mrr || PLAN_MRR[plan] || 0;

  // Uso do Cortex no mês
  const thisMonth = new Date().toISOString().slice(0, 7);
  let cortexCalls = 0, tokensUsed = 0;
  try {
    const usageSnap = await db.collection('data').doc(tenantId)
      .collection('usage').where('month', '==', thisMonth).get();
    usageSnap.forEach(d => {
      cortexCalls += d.data().cortexCalls || 0;
      tokensUsed += d.data().tokens || 0;
    });
  } catch {}

  const createdAt = t.createdAt ? new Date(t.createdAt.seconds * 1000) : new Date();
  const ageMonths = Math.max(1, Math.round((Date.now() - createdAt) / 2592000000));
  const ltv = planMRR * Math.max(ageMonths, 12);

  return {
    tenantId, name: t.name || tenantId, plan, mrr: planMRR, arr: planMRR * 12, ltv,
    ageMonths, cortexCalls, tokensUsed,
    status: t.status || 'active',
    health: cortexCalls > 50 ? 'high' : cortexCalls > 10 ? 'medium' : 'low'
  };
}

async function getChurnMetrics() {
  if (!db) return { churnRate: 0, churnedTenants: [], atRisk: [] };
  const tenantsSnap = await db.collection('tenants').get();
  const tenants = tenantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const now = Date.now();
  const atRisk = [];

  for (const t of tenants) {
    if (t.status !== 'active' && t.status !== 'ativo') continue;
    // Critérios de risco: sem uso há 14+ dias, plano free, trial expirando
    let riskScore = 0;
    const lastActivity = t.lastActivity?.seconds ? t.lastActivity.seconds * 1000 : null;
    if (lastActivity && now - lastActivity > 14 * 86400000) riskScore += 40;
    if ((t.plan || 'free') === 'free') riskScore += 20;
    if (t.paymentStatus === 'overdue') riskScore += 50;
    const trialEnd = t.trialEnd?.seconds ? t.trialEnd.seconds * 1000 : null;
    if (trialEnd && trialEnd - now < 7 * 86400000 && trialEnd > now) riskScore += 30;
    if (riskScore >= 40) {
      atRisk.push({ id: t.id, name: t.name || t.id, riskScore, plan: t.plan || 'free', lastActivity });
    }
  }

  const churned = tenants.filter(t => t.status === 'churned' || t.status === 'cancelled');
  return {
    atRisk: atRisk.sort((a, b) => b.riskScore - a.riskScore).slice(0, 10),
    churnedCount: churned.length,
    atRiskCount: atRisk.length
  };
}

async function getMRRTimeline() {
  if (!db) return [];
  try {
    const snap = await db.collection('empire_metrics')
      .orderBy('ts', 'asc').limit(12).get();
    return snap.docs.map(d => {
      const data = d.data();
      return { month: data.month || '—', mrr: data.mrr || 0, arr: data.arr || 0, tenants: data.activeTenants || 0 };
    });
  } catch { return []; }
}

async function getCohortData() {
  if (!db) return [];
  const tenantsSnap = await db.collection('tenants').get();
  const cohorts = {};
  tenantsSnap.forEach(doc => {
    const t = doc.data();
    const month = t.createdAt
      ? new Date(t.createdAt.seconds * 1000).toISOString().slice(0, 7)
      : 'unknown';
    if (!cohorts[month]) cohorts[month] = { month, total: 0, active: 0, mrr: 0 };
    cohorts[month].total++;
    if (t.status === 'active' || t.status === 'ativo') {
      cohorts[month].active++;
      cohorts[month].mrr += PLAN_MRR[t.plan || 'free'] || 0;
    }
  });
  return Object.values(cohorts)
    .map(c => ({ ...c, retention: c.total > 0 ? Math.round((c.active / c.total) * 100) : 0 }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

function getMockKPIs() {
  return {
    mrr: 0, arr: 0, ltv: 0, churnRate: 0, mrrGrowth: 0, nrr: 100, cac: 0,
    activeTenants: 0, newThisMonth: 0, churnedThisMonth: 0,
    note: 'Firebase não configurado — sem dados reais'
  };
}
