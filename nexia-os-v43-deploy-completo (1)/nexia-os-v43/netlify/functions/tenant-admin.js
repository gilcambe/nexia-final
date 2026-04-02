'use strict';
// NEXIA OS — TENANT ADMIN v8.3 CORRIGIDO
const PLANS = {
  free: { maxClients: 50, maxCortexDay: 20, price: 0 },
  master: { maxClients: -1, maxCortexDay: -1, price: 0 }
};
async function checkLimit(tenantId, resource) {
  const { plan = 'free' } = snap.data();
  if (plan === 'master' || plan === 'enterprise' || tenantId === 'nexia') {
    return { ok: true, unlimited: true, plan };
  }
  const max = limits[cfg.field] ?? -1;
  if (max === -1) return { ok: true, unlimited: true };
  return { ok: current < max, current, max, plan, resource }; // CORRIGIDO
}