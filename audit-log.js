'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS — Audit Log API v1.0                               ║
 * ║  Escrita segura em audit_log_global via Admin SDK            ║
 * ║  Criado para corrigir VULN-09: frontend não pode escrever    ║
 * ║  em audit_log_global (create:false nas Firestore Rules)      ║
 * ╚══════════════════════════════════════════════════════════════╝
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
  console.warn('[AUDIT] Firebase indisponivel:', e.message);
  db = null;
}

const { requireBearerAuth, HEADERS, makeHeaders } = require('./middleware');

const ALLOWED_SEVERITIES = new Set(['OK', 'INFO', 'AVISO', 'CRÍTICO', 'WARN', 'ERROR']);

exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // Exige autenticação Bearer (Firebase ID Token)
  const authErr = await requireBearerAuth(event);
  if (authErr) return { ...authErr, headers };

  // Apenas master/admin pode escrever audit logs
  if (event._role !== 'master' && event._role !== 'admin') {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Permissão insuficiente para escrever audit log.' }) };
  }

  if (!db) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Serviço temporariamente indisponível.' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { severity, message, tenant, uid: bodyUid } = body;

    // Validação básica
    if (!message || typeof message !== 'string' || message.length > 500) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'message inválida ou ausente (max 500 chars).' }) };
    }
    const sev = ALLOWED_SEVERITIES.has(severity) ? severity : 'INFO';
    const tenantId = typeof tenant === 'string' && tenant.length < 60 ? tenant : 'nexia';

    await db.collection('audit_log_global').add({
      severity: sev,
      message: message.trim(),
      tenant: tenantId,
      uid: event._uid || bodyUid || 'unknown',
      source: 'master-admin-frontend',
      ts: admin.firestore.FieldValue.serverTimestamp(),
      ttl: admin.firestore.Timestamp.fromMillis(Date.now() + 90 * 24 * 3600 * 1000) // 90 dias
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('[AUDIT] Erro ao escrever:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
