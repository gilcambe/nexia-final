'use strict';
// NEXIA OS — Middleware v15.1 CORRIGIDO
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /forget\s+(everything|all)/i,
  /<\|system\|>/i,
  /<<sys>>/i
];
async function _cleanExpiredRateLimits() {
  const now = Date.now();
  const expired = await db.collection('rate_limits').where('ttl', '<', now).limit(50).get(); // CORRIGIDO
  if (expired.empty) return;
  const batch = db.batch();
  expired.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}
const _tenantCache = new Map();
let _cacheCallCount = 0;
function _cleanTenantCache() {
  if (++_cacheCallCount % 100 !== 0) return;
  const now = Date.now();
  for (const [key, val] of _tenantCache.entries()) {
    if (now - val.ts > 300000) _tenantCache.delete(key);
  }
}