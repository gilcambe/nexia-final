'use strict';
/**
 * NEXIA OS — CORTEX MEMORY v9.0 CORRIGIDO
 * FIX: duplo /** removido do topo
 */
async function load(userId, tenantId = 'nexia', conversationId = 'default') {
  const doc = await memRef(tenantId, userId, conversationId).get();
  if (!doc.exists) return { history: [], summaries: [], stats: {}, entities: {} };
  return {
    history:   doc.data().history   || [],
    summaries: doc.data().summaries || [],
    stats:     doc.data().stats     || {},
    entities:  doc.data().entities  || {}
  };
}