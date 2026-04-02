'use strict';
/**
/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — OSINT Hub v1.1                           ║
 * ║  CPF/CNPJ via Receita Federal + BrasilAPI            ║
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

async function queryCNPJ(cnpj) {
  const clean = cnpj.replace(/\D/g, '');
  const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${clean}`);
  if (!res.ok) throw new Error(`BrasilAPI CNPJ error: ${res.status}`);
  return await res.json();
}

async function queryCEP(cep) {
  const clean = cep.replace(/\D/g, '');
  const res = await fetch(`https://brasilapi.com.br/api/cep/v2/${clean}`);
  if (!res.ok) throw new Error(`BrasilAPI CEP error: ${res.status}`);
  return await res.json();
}

exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  // CORRIGIDO v38: autenticação obrigatória (dados sensíveis de CNPJ/CPF)
  const authErr = await requireBearerAuth(event);
  if (authErr) return authErr;
  try {
    const { query, type = 'cnpj', tenantId } = event.queryStringParameters || {};
    if (!query) return { statusCode: 400, headers, body: JSON.stringify({ error: 'query parameter required' }) };

    let result;
    if (type === 'cnpj') result = await queryCNPJ(query);
    else if (type === 'cep') result = await queryCEP(query);
    else return { statusCode: 400, headers, body: JSON.stringify({ error: 'type must be cnpj or cep' }) };

    // Log to Firestore for audit trail
    if (tenantId) {
      await db.collection('tenants').doc(tenantId).collection('osint_log').add({
        query, type, timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ query, type, result }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
