'use strict';
/**
/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — Takedown Engine v1.1                     ║
 * ║  Gerador de dossiê DMCA via Anthropic API            ║
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


const { requireBearerAuth, makeHeaders} = require('./middleware');

exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  // CORRIGIDO v38: requireBearerAuth
    const _aErr = await requireBearerAuth(event);
  if (_aErr) return _aErr;
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const { url, brand, evidence, tenantId } = JSON.parse(event.body || '{}');
    if (!url || !brand) return { statusCode: 400, headers, body: JSON.stringify({ error: 'url e brand são obrigatórios' }) };

    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) return { statusCode: 503, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY não configurada' }) };

    const prompt = `Você é um especialista em direito digital e propriedade intelectual. Gere um dossiê DMCA profissional em português para:
- Marca/Titular: ${brand}
- URL Infratora: ${url}
- Evidências: ${evidence || 'Uso não autorizado de marca registrada'}

Inclua: 1) Identificação do titular, 2) Descrição da infração, 3) Declaração de boa-fé, 4) Pedido de remoção, 5) Assinatura eletrônica padrão.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    const dossierText = data.content?.[0]?.text || '';
    const dossierId = `TK-${Date.now()}`;

    if (tenantId) {
      await db.collection('tenants').doc(tenantId).collection('takedowns').doc(dossierId).set({
        url, brand, evidence, dossierText, createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ status: 'generated', dossier_id: dossierId, dossier: dossierText }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
