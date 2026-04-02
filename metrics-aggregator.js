'use strict';
/**
/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — Metrics Aggregator v1.2                  ║
 * ║  Cross-tenant KPI aggregation from Firestore         ║
 * ║  SECURITY FIX: requireBearerAuth adicionado          ║
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

const { requireBearerAuth, HEADERS, makeHeaders } = require('./middleware');

exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // SECURITY FIX: endpoint expõe dados financeiros de todos os tenants — requer master token
  const METRICS_SECRET = process.env.METRICS_SECRET;
  if (!METRICS_SECRET) {
    console.error('[metrics-aggregator] METRICS_SECRET não configurado');
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Serviço não configurado' }) };
  }
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (authHeader !== `Bearer ${METRICS_SECRET}`) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized — token de métricas inválido' }) };
  }

  if (!db) return { statusCode: 503, headers, body: JSON.stringify({ error: 'Firebase indisponível' }) };

  try {
    const tenantsSnap = await db.collection('tenants').where('status', '==', 'active').get();
    let totalMrr = 0, activeTenants = 0, totalRevenue = 0;
    const tenantMetrics = [];

    for (const tenantDoc of tenantsSnap.docs) {
      const data = tenantDoc.data();
      const plan = data.subscription?.plan || 'free';
      const planValues = { starter: 297, pro: 597, enterprise: 1497, free: 0 };
      const mrr = planValues[plan] || 0;
      totalMrr += mrr;
      activeTenants++;

      // Sum payments
      const paymentsSnap = await db.collection('tenants').doc(tenantDoc.id).collection('payments')
        .where('status', '==', 'approved').get();
      let tenantRevenue = 0;
      paymentsSnap.forEach(p => { tenantRevenue += p.data().amount || 0; });
      totalRevenue += tenantRevenue;

      tenantMetrics.push({ id: tenantDoc.id, name: data.name, plan, mrr, revenue: tenantRevenue });
    }

    const avgLtv = activeTenants > 0 ? Math.round(totalRevenue / activeTenants) : 0;
    const arr = totalMrr * 12;

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        date: new Date().toISOString().split('T')[0],
        total_mrr: totalMrr,
        arr,
        active_tenants: activeTenants,
        avg_ltv: avgLtv,
        tenants: tenantMetrics
      })
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
