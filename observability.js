
/**
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS — OBSERVABILITY v10.0  (NOVO)                     ║
 * ║  Health · Métricas · Alertas · Performance                   ║
 * ║  FASE 6: Escala — logs estruturados, cache, rate limit      ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * GET  /api/observe?action=health              → health check
 * GET  /api/observe?action=metrics&tenantId=x  → métricas do tenant
 * POST /api/observe { action: "alert", ... }   → envia alerta
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
const { guard, HEADERS, makeHeaders } = require('./middleware');


// ── Cache em memória (shared entre warm invocations) ─────────
const _cache = new Map();
const CACHE_TTL = 30_000; // 30s


function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return entry.value;
}
function cacheSet(key, value) { _cache.set(key, { value, ts: Date.now() }); }


// ── Health check ──────────────────────────────────────────────
async function healthCheck() {
  const checks = {};
  const start = Date.now();


  // Firestore
  try {
    await db.collection('health').doc('ping').set({ ts: admin.firestore.FieldValue.serverTimestamp() });
    checks.firestore = { ok: true, ms: Date.now() - start };
  } catch (e) {
    checks.firestore = { ok: false, error: e.message };
  }


  // Groq API
  const groqStart = Date.now();
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` }
    });
    checks.groq = { ok: res.ok, ms: Date.now() - groqStart, status: res.status };
  } catch (e) {
    checks.groq = { ok: false, error: e.message };
  }


  // DeepSeek
  if (process.env.DEEPSEEK_API_KEY) {
    const dsStart = Date.now();
    try {
      const res = await fetch('https://api.deepseek.com/models', {
        headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` }
      });
      checks.deepseek = { ok: res.ok, ms: Date.now() - dsStart };
    } catch (e) {
      checks.deepseek = { ok: false, error: e.message };
    }
  }


  const allOk = Object.values(checks).every(c => c.ok);
  return {
    status: allOk ? 'healthy' : 'degraded',
    version: 'v10.0',
    timestamp: new Date().toISOString(),
    totalMs: Date.now() - start,
    checks
  };
}


// ── Métricas do tenant ────────────────────────────────────────
async function getMetrics(tenantId, hours = 24) {
  const cached = cacheGet(`metrics:${tenantId}:${hours}`);
  if (cached) return { ...cached, cached: true };


  const since = admin.firestore.Timestamp.fromDate(new Date(Date.now() - hours * 3600_000));


  const [execSnap, actionSnap, errSnap] = await Promise.all([
    db.collection('tenants').doc(tenantId).collection('cortex_logs')
      .where('type', '==', 'cortex_execution')
      .where('ts', '>=', since).get(),
    db.collection('tenants').doc(tenantId).collection('action_logs')
      .where('ts', '>=', since).get(),
    db.collection('tenants').doc(tenantId).collection('cortex_logs')
      .where('type', '==', 'cortex_error')
      .where('ts', '>=', since).get()
  ]);


  let totalMs = 0, count = 0;
  const intentBreakdown = {}, modelBreakdown = {}, activeUsers = new Set();
  const hourlyBuckets = {};


  for (const doc of execSnap.docs) {
    const d = doc.data();
    if (d.ms) { totalMs += d.ms; count++; }
    if (d.intent) intentBreakdown[d.intent] = (intentBreakdown[d.intent] || 0) + 1;
    if (d.modelUsed) modelBreakdown[d.modelUsed] = (modelBreakdown[d.modelUsed] || 0) + 1;
    if (d.userId) activeUsers.add(d.userId);


    // Hourly bucket
    const ts = d.ts?.toDate?.() || new Date();
    const hour = ts.toISOString().slice(0, 13);
    hourlyBuckets[hour] = (hourlyBuckets[hour] || 0) + 1;
  }


  const metrics = {
    tenantId, period: `${hours}h`,
    cortexCalls: execSnap.size,
    actionsCalled: actionSnap.size,
    errors: errSnap.size,
    errorRate: execSnap.size > 0 ? ((errSnap.size / execSnap.size) * 100).toFixed(1) + '%' : '0%',
    avgResponseMs: count > 0 ? Math.round(totalMs / count) : 0,
    p95ResponseMs: 0, // seria calculado com percentis reais
    activeUsers: activeUsers.size,
    intentBreakdown,
    modelBreakdown,
    hourlyBuckets: Object.entries(hourlyBuckets).map(([h, c]) => ({ hour: h, calls: c }))
  };


  cacheSet(`metrics:${tenantId}:${hours}`, metrics);
  return metrics;
}


// ── Alerta ────────────────────────────────────────────────────
async function sendAlert(tenantId, type, message, severity = 'info') {
  await db.collection('tenants').doc(tenantId).collection('alerts').add({
    type, message, severity, tenantId,
    ts: admin.firestore.FieldValue.serverTimestamp(),
    read: false
  });
  if (process.env.NODE_ENV !== 'production') console.warn(`[ALERT] [${severity.toUpperCase()}] ${tenantId}: ${message}`);
}


// ── HANDLER ───────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };


  // Health é público
  const params = event.queryStringParameters || {};
  if (params.action === 'health') {
    const result = await healthCheck();
    return { statusCode: result.status === 'healthy' ? 200 : 503, headers, body: JSON.stringify(result) };
  }


  const guardErr = await guard(event, 'default');
  if (guardErr) return guardErr;


  try {
    if (event.httpMethod === 'GET') {
      const { tenantId, hours = '24' } = params;
      if (params.action === 'metrics') {
        if (!tenantId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'tenantId obrigatório' }) };
        const metrics = await getMetrics(tenantId, parseInt(hours));
        return { statusCode: 200, headers, body: JSON.stringify(metrics) };
      }
    }


    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (body.action === 'alert') {
        await sendAlert(body.tenantId, body.type, body.message, body.severity);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }
    }


    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ação não reconhecida' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};


module.exports.sendAlert = sendAlert;
module.exports.cacheGet  = cacheGet;
module.exports.cacheSet  = cacheSet;








