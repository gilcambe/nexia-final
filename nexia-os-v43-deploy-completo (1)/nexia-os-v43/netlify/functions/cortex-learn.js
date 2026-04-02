'use strict';
// NEXIA OS — CORTEX LEARN v9.0 CORRIGIDO
function bigrams(tokens) {
  const bg = new Set();
  for (let i = 0; i < tokens.length - 1; i++) { // CORRIGIDO
    bg.add(tokens[i] + '_' + tokens[i + 1]);
  }
  return bg;
}
async function pruneOldExamples(tenantId) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - EXAMPLE_TTL_DAYS);
  const snap = await db.collection('cortex_good_responses')
    .doc(tenantId).collection('examples')
    .where('rating', '<=', 2) // CORRIGIDO
    .where('lastUsed', '<', admin.firestore.Timestamp.fromDate(cutoff)) // CORRIGIDO
    .limit(20).get();
}