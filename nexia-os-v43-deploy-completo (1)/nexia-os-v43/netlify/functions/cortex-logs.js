'use strict';
/**
 * NEXIA OS — CORTEX LOGS v9.0 CORRIGIDO
 * FIX: bloco duplicado no final REMOVIDO
 */
async function getLogs(tenantId, filters = {}) {
  const { userId, type, limit = 50 } = filters;
  let q = db.collection('tenants').doc(tenantId).collection('cortex_logs')
    .orderBy('ts', 'desc').limit(Math.min(parseInt(limit) || 50, 500));
  if (userId) q = q.where('userId', '==', userId);
  if (type)   q = q.where('type', '==', type);
  const snap = await q.get();
  return { logs: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
}
exports.handler = async (event) => { /* handler logic */ };
// FIM DO ARQUIVO