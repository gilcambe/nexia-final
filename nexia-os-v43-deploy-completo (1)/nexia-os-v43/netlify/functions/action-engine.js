'use strict';
// NEXIA OS — ACTION ENGINE v9.0 CORRIGIDO
function sanitizeStr(val) {
  if (typeof val !== 'string') return val;
  return val.replace(/<[^>]*>/g, '').replace(/[{}$]/g, '').trim().slice(0, 1000); // CORRIGIDO
}