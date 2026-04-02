'use strict';
/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — Payment Engine v3.0 (SECURITY HARDENED) ║
 * ║  FIXES: auth guard, tenant isolation on GET,         ║
 * ║         crypto explicit import, rate limit           ║
 * ╚══════════════════════════════════════════════════════╝
 */
const crypto = require('crypto'); // FIXED: explicit import (Node <19 compat)

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

const { guard, HEADERS, makeHeaders: MW_HEADERS, checkRateLimit } = require('./middleware');
const MP_TOKEN = () => process.env.MP_ACCESS_TOKEN;

// ── HMAC Webhook Validation ──────────────────────────────────────────────────
function validateMPSignature(event) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;
  const xSignature = event.headers['x-signature'] || event.headers['X-Signature'] || '';
  const xRequestId = event.headers['x-request-id'] || event.headers['X-Request-Id'] || '';
  const dataId     = (event.queryStringParameters || {})['data.id'] || '';
  const parts = {};
  xSignature.split(',').forEach(part => { const [k,v]=part.trim().split('='); if(k&&v) parts[k]=v; });
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${parts.ts};`;
  const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(parts.v1));
}

// ── Token verification helper ────────────────────────────────────────────────
async function verifyCallerToken(event) {
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded;
  } catch { return null; }
}

// ── MP API helper ────────────────────────────────────────────────────────────
async function mpPost(path, body) {
  const token = MP_TOKEN();
  if (!token) throw new Error('MP_ACCESS_TOKEN não configurado');
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || `MP API ${res.status}`);
  return data;
}

async function mpGet(path) {
  const token = MP_TOKEN();
  if (!token) throw new Error('MP_ACCESS_TOKEN não configurado');
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `MP API ${res.status}`);
  return data;
}

// ── Ledger helper ────────────────────────────────────────────────────────────
async function saveLedger(tenantId, id, data) {
  await db.collection('tenants').doc(tenantId).collection('payments').doc(String(id)).set({
    ...data, updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

// ── ACTION HANDLERS ──────────────────────────────────────────────────────────
async function actionCreate(body, tenantId) {
  const { amount, payerEmail, payerName, description, method, dueDate, externalRef } = body;
  if (!amount || !payerEmail) throw new Error('amount e payerEmail são obrigatórios');
  const isCard = method && method.toLowerCase().includes('cart');
  if (!isCard) {
    const payment = await mpPost('/v1/payments', {
      transaction_amount: parseFloat(amount),
      description: description || 'Cobrança NEXIA OS',
      payment_method_id: 'pix',
      payer: { email: payerEmail, first_name: payerName || payerEmail.split('@')[0] },
      external_reference: externalRef || `nexia-${tenantId}-${Date.now()}`,
      date_of_expiration: dueDate ? new Date(dueDate + 'T23:59:59-03:00').toISOString() : undefined
    });
    await saveLedger(tenantId, payment.id, {
      paymentId: payment.id, status: payment.status, amount, currency: 'BRL',
      payerEmail, method: 'pix',
      qrCode: payment.point_of_interaction?.transaction_data?.qr_code_base64,
      qrCodeText: payment.point_of_interaction?.transaction_data?.qr_code,
      externalRef: payment.external_reference, description
    });
    return {
      ok: true, paymentId: payment.id, status: payment.status,
      qrCode: payment.point_of_interaction?.transaction_data?.qr_code_base64,
      qrCodeText: payment.point_of_interaction?.transaction_data?.qr_code
    };
  }
  const pref = await mpPost('/checkout/preferences', {
    items: [{ title: description || 'Cobrança NEXIA', quantity: 1, unit_price: parseFloat(amount), currency_id: 'BRL' }],
    payer: { email: payerEmail, name: payerName },
    external_reference: externalRef || `nexia-${tenantId}-${Date.now()}`,
    back_urls: { success: `${process.env.NEXIA_APP_URL || ''}/nexia/nexia-pay.html`, failure: `${process.env.NEXIA_APP_URL || ''}/nexia/nexia-pay.html` },
    auto_return: 'approved'
  });
  await saveLedger(tenantId, pref.id, {
    paymentId: pref.id, status: 'pending', amount, currency: 'BRL',
    payerEmail, method: 'credit_card', paymentLink: pref.init_point, description
  });
  return { ok: true, paymentId: pref.id, paymentLink: pref.init_point, initPoint: pref.init_point };
}

async function actionCreateLink(body, tenantId) {
  const { amount, description, payerEmail } = body;
  if (!amount) throw new Error('amount é obrigatório');
  const pref = await mpPost('/checkout/preferences', {
    items: [{ title: description || 'Link de Pagamento NEXIA', quantity: 1, unit_price: parseFloat(amount), currency_id: 'BRL' }],
    payer: payerEmail ? { email: payerEmail } : undefined,
    external_reference: `link-${tenantId}-${Date.now()}`,
    back_urls: { success: `${process.env.NEXIA_APP_URL || ''}/nexia/nexia-pay.html` }
  });
  await saveLedger(tenantId, pref.id, {
    paymentId: pref.id, status: 'pending', amount, currency: 'BRL',
    method: 'link', paymentLink: pref.init_point, description
  });
  return { ok: true, paymentId: pref.id, paymentLink: pref.init_point, initPoint: pref.init_point };
}

async function actionPix(body, tenantId) { return actionCreate({ ...body, method: 'pix' }, tenantId); }

async function actionRetry(body, tenantId) {
  const { paymentId } = body;
  if (!paymentId) throw new Error('paymentId é obrigatório');
  const doc = await db.collection('tenants').doc(tenantId).collection('payments').doc(String(paymentId)).get();
  if (!doc.exists) throw new Error('Pagamento não encontrado no ledger');
  const tx = doc.data();
  return actionCreate({ amount: tx.amount, payerEmail: tx.payerEmail, description: tx.description, method: 'pix' }, tenantId);
}

// ── WEBHOOK HANDLER ──────────────────────────────────────────────────────────
async function handleWebhook(event) {
  if (!validateMPSignature(event)) {
    await db.collection('audit_log_global').add({ ttl: admin.firestore.Timestamp.fromMillis(Date.now() + 2592000000),
      severity: 'AVISO', message: 'Webhook MP rejeitado — assinatura HMAC inválida',
      ip: event.headers['x-forwarded-for'] || 'unknown',
      ts: admin.firestore.FieldValue.serverTimestamp()
    });
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
  }
  const payload = JSON.parse(event.body || '{}');
  const { type, data: mpData } = payload;
  if (type === 'payment' && mpData?.id) {
    const payment = await mpGet(`/v1/payments/${mpData.id}`);
    // FIXED: tenantId from external_reference, NOT from user body (prevents spoofing)
    const externalRef = payment.external_reference || '';
    const tenantIdFromRef = externalRef.startsWith('nexia-') ? externalRef.split('-')[1] : 'global';
    await saveLedger(tenantIdFromRef, mpData.id, {
      paymentId: mpData.id, status: payment.status,
      amount: payment.transaction_amount, currency: payment.currency_id,
      payerEmail: payment.payer?.email, method: payment.payment_method_id,
      externalRef: payment.external_reference
    });
    if (payment.status === 'approved' && tenantIdFromRef !== 'global') {
      await db.collection('tenants').doc(tenantIdFromRef).update({
        'subscription.status': 'active',
        'subscription.lastPayment': admin.firestore.FieldValue.serverTimestamp()
      });
    }
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, status: payment.status }) };
  }
  return { statusCode: 200, headers, body: JSON.stringify({ received: true, type }) };
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    // FIXED: Webhook path — validate HMAC, skip user auth
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { action } = body;

      // Webhook from Mercado Pago (no action field)
      if (!action) return handleWebhook(event);

      // FIXED: All other POST actions require authentication
      const decoded = await verifyCallerToken(event);
      if (!decoded) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token de autenticação obrigatório' }) };

      // FIXED: tenantId must match caller's tenant
      const { tenantId } = body;
      if (!tenantId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'tenantId obrigatório' }) };

      // Verify caller belongs to this tenant
      const userDoc = await db.collection('users').doc(decoded.uid).get();
      if (!userDoc.exists) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Usuário não encontrado' }) };
      const userTenant = userDoc.data().tenantSlug;
      const userRole = userDoc.data().role;
      if (userTenant !== tenantId && userRole !== 'master' && userDoc.data().tenantSlug !== 'nexia') {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Acesso negado a este tenant' }) };
      }

      // Rate limit per user
      const rl = await checkRateLimit(decoded.uid, 'billing');
      if (!rl.ok) return { statusCode: 429, headers, body: JSON.stringify({ error: 'Rate limit excedido' }) };

      const actionMap = { create: actionCreate, create_link: actionCreateLink, pix: actionPix, retry: actionRetry };
      if (!actionMap[action]) return { statusCode: 400, headers, body: JSON.stringify({ error: `Ação desconhecida: ${action}` }) };
      const result = await actionMap[action](body, tenantId);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    if (event.httpMethod === 'GET') {
      // FIXED: Require auth on GET — verify caller owns this tenant
      const decoded = await verifyCallerToken(event);
      if (!decoded) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token obrigatório' }) };

      const { tenantId } = event.queryStringParameters || {};
      if (!tenantId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'tenantId required' }) };

      // FIXED: Tenant isolation check
      const userDoc = await db.collection('users').doc(decoded.uid).get();
      if (!userDoc.exists) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Usuário não encontrado' }) };
      const userTenant = userDoc.data().tenantSlug;
      const userRole = userDoc.data().role;
      if (userTenant !== tenantId && userRole !== 'master' && userTenant !== 'nexia') {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Acesso negado' }) };
      }

      const snap = await db.collection('tenants').doc(tenantId).collection('payments').orderBy('updatedAt', 'desc').limit(20).get();
      return { statusCode: 200, headers, body: JSON.stringify({ payments: snap.docs.map(d => ({ id: d.id, ...d.data() })) }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ status: 'active', engine: 'NEXIA Pay v3.0' }) };
  } catch (err) {
    console.error('[payment-engine]', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
