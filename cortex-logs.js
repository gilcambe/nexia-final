/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — CORTEX LOGS v9.0                        ║
 * ║  Filtros avançados · Paginação · Stats · Export     ║
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
const { guard, HEADERS, makeHeaders } = require('./middleware');


async function getLogs(tenantId, filters = {}) {
  const { userId, type, limit = 50, after } = filters;
  let q = db.collection('tenants').doc(tenantId).collection('cortex_logs')
    .orderBy('ts', 'desc')
    .limit(Math.min(parseInt(limit) || 50, 500));
  if (userId) q = q.where('userId', '==', userId);
  if (type)   q = q.where('type',   '==', type);
  if (after) {
    const cursorDoc = await db.collection('tenants').doc(tenantId).collection('cortex_logs').doc(after).get();
    if (cursorDoc.exists) q = q.startAfter(cursorDoc);
  }
  const snap = await q.get();
  const logs = snap.docs.map(d => ({ id: d.id, ...d.data(), ts: d.data().ts?.toDate?.()?.toISOString() || d.data().ts }));
  return { logs, nextCursor: snap.docs.length > 0 ? snap.docs[snap.docs.length - 1].id : null };
}


async function getStats(tenantId, hours = 24) {
  const since = new Date(Date.now() - hours * 3600_000);
  const [execSnap, errSnap, actionSnap] = await Promise.all([
    db.collection('tenants').doc(tenantId).collection('cortex_logs')
      .where('type', '==', 'cortex_execution')
      .where('ts', '>=', admin.firestore.Timestamp.fromDate(since)).get(),
    db.collection('tenants').doc(tenantId).collection('cortex_logs')
      .where('error', '!=', null)
      .where('ts', '>=', admin.firestore.Timestamp.fromDate(since)).get(),
    db.collection('tenants').doc(tenantId).collection('action_logs')
      .where('ts', '>=', admin.firestore.Timestamp.fromDate(since)).get()
  ]);
  let totalMs = 0, msCount = 0;
  const intentBreakdown = {}, actionBreakdown = {};
  const activeUsers = new Set();
  for (const d of execSnap.docs) {
    const data = d.data();
    if (data.ms)     { totalMs += data.ms; msCount++; }
    if (data.intent) intentBreakdown[data.intent] = (intentBreakdown[data.intent] || 0) + 1;
    if (data.userId) activeUsers.add(data.userId);
  }
  for (const d of actionSnap.docs) {
    const a = d.data().action;
    if (a) actionBreakdown[a] = (actionBreakdown[a] || 0) + 1;
  }
  return {
    period: `últimas ${hours}h`,
    cortexCalls:     execSnap.size,
    avgResponseMs:   msCount ? Math.round(totalMs / msCount) : 0,
    errorCount:      errSnap.size,
    errorRate:       execSnap.size > 0 ? ((errSnap.size / execSnap.size) * 100).toFixed(1) + '%' : '0%',
    activeUsers:     activeUsers.size,
    actionsCalled:   actionSnap.size,
    intentBreakdown,
    actionBreakdown,
    topActions: Object.entries(actionBreakdown).sort((a,b) => b[1]-a[1]).slice(0, 5)
  };
}


exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: 'Method Not Allowed' };
  const guardErr = await guard(event, 'cortex-logs', { skipTenant: true });
  if (guardErr) return guardErr;
  try {
    const p = event.queryStringParameters || {};
    const tenantId = p.tenantId;
    if (!tenantId) throw new Error('tenantId obrigatório');
    if (p.action === 'stats') {
      return { statusCode: 200, headers, body: JSON.stringify(await getStats(tenantId, parseInt(p.hours) || 24)) };
    }
    const result = await getLogs(tenantId, p);
    const stats  = { total: result.logs.length, byType: {}, avgMs: 0, errorCount: 0 };
    let totalMs = 0, msCount = 0;
    for (const l of result.logs) {
      stats.byType[l.type] = (stats.byType[l.type] || 0) + 1;
      if (l.ms)    { totalMs += l.ms; msCount++; }
      if (l.error) { stats.errorCount++; }
    }
    if (msCount) stats.avgMs = Math.round(totalMs / msCount);
    return { statusCode: 200, headers, body: JSON.stringify({ logs: result.logs, stats, nextCursor: result.nextCursor }) };
  } catch (err) {
    console.error('[CORTEX-LOGS] ❌', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};








'use strict';


/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — CORTEX LOGS v9.0                        ║
 * ║  Filtros avançados · Paginação · Stats · Export     ║
 * ╚══════════════════════════════════════════════════════╝
 */


