'use strict';
/**
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS — BILLING v10.2  (MERCADO PAGO — SEM STRIPE)      ║
 * ║  Checkout Link · Pix QR · Webhook IPN · Aprovação Manual    ║
 * ║  Free / Starter R$97 / Pro R$297 / Enterprise               ║
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
  console.warn('[NEXIA] Firebase indisponivel:', e.message);
  db = null;
}
const now = () => admin && admin.firestore
  ? admin.firestore.FieldValue.serverTimestamp()
  : new Date().toISOString();
const { guard, HEADERS, makeHeaders } = require('./middleware');

const MP_API  = 'https://api.mercadopago.com';
const APP_URL = process.env.NEXIA_APP_URL || 'https://nexia.app';

const PLANS = {
  free:       { name: 'Free',       price: 0,   currency: 'BRL' },
  starter:    { name: 'Starter',    price: 97,  currency: 'BRL' },
  pro:        { name: 'Pro',        price: 297, currency: 'BRL' },
  enterprise: { name: 'Enterprise', price: 0,   currency: 'BRL' }
};

async function mpPost(endpoint, body) {
  const res = await fetch(`${MP_API}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `nexia-${Date.now()}-${Math.random().toString(36).slice(2)}`
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || 'Mercado Pago error');
  return data;
}

async function mpGet(endpoint) {
  const res = await fetch(`${MP_API}${endpoint}`, {
    headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'MP error');
  return data;
}

async function createCheckout(tenantId, userId, plan, payerEmail, payerName) {
  const planData = PLANS[plan];
  if (!planData || planData.price === 0) throw new Error(`Plano "${plan}" inválido para checkout`);

  const preference = await mpPost('/checkout/preferences', {
    items: [{
      id: `nexia-${plan}`,
      title: `NEXIA OS — Plano ${planData.name}`,
      description: `Assinatura mensal NEXIA OS ${planData.name}`,
      quantity: 1,
      unit_price: planData.price,
      currency_id: 'BRL'
    }],
    payer: { email: payerEmail || '', name: payerName || '' },
    back_urls: {
      success: `${APP_URL}/billing/success?tenant=${tenantId}&plan=${plan}`,
      failure: `${APP_URL}/billing/failure?tenant=${tenantId}`,
      pending: `${APP_URL}/billing/pending?tenant=${tenantId}`
    },
    auto_return: 'approved',
    notification_url: `${APP_URL}/api/billing`,
    metadata: { tenantId, userId, plan, source: 'nexia_os' },
    statement_descriptor: 'NEXIA OS',
    external_reference: `${tenantId}:${plan}:${Date.now()}`
  });

  await db.collection('tenants').doc(tenantId).collection('billing_history').add({
    type: 'checkout_created', plan,
    preferenceId: preference.id,
    amount: planData.price,
    status: 'pending', userId, payerEmail, createdAt: now()
  });

  return {
    url: preference.init_point,
    sandbox_url: preference.sandbox_init_point,
    preferenceId: preference.id,
    plan: planData
  };
}

async function createPix(tenantId, userId, plan, payerEmail, cpf) {
  const planData = PLANS[plan];
  if (!planData || planData.price === 0) throw new Error(`Plano "${plan}" inválido`);

  const payment = await mpPost('/v1/payments', {
    transaction_amount: planData.price,
    description: `NEXIA OS — Plano ${planData.name}`,
    payment_method_id: 'pix',
    payer: {
      email: payerEmail,
      identification: { type: 'CPF', number: (cpf || '00000000000').replace(/\D/g, '') }
    },
    metadata: { tenantId, userId, plan }
  });

  await db.collection('tenants').doc(tenantId).collection('billing_history').add({
    type: 'pix_created', plan,
    paymentId: payment.id,
    amount: planData.price,
    status: 'pending', userId, payerEmail, createdAt: now()
  });

  return {
    paymentId: payment.id,
    status: payment.status,
    qr_code: payment.point_of_interaction?.transaction_data?.qr_code,
    qr_code_base64: payment.point_of_interaction?.transaction_data?.qr_code_base64,
    ticket_url: payment.point_of_interaction?.transaction_data?.ticket_url,
    expires_at: payment.date_of_expiration
  };
}

async function processWebhook(body, query) {
  const topic = query?.topic || body?.type;
  const mpId  = query?.id   || body?.data?.id;
  if (!topic || !mpId) return { ok: true, skipped: true };

  if (process.env.NODE_ENV !== 'production') console.warn(`[BILLING] Webhook MP: topic=${topic} id=${mpId}`);

  if (topic === 'payment') {
    const payment = await mpGet(`/v1/payments/${mpId}`);
    const { status, metadata, external_reference, transaction_amount } = payment;

    let tenantId = metadata?.tenantId;
    let plan     = metadata?.plan;
    if (!tenantId && external_reference) {
      [tenantId, plan] = external_reference.split(':');
    }
    if (!tenantId) return { ok: true, skipped: true, reason: 'no tenantId' };

    if (status === 'approved') {
      await db.collection('tenants').doc(tenantId).update({
        plan: plan || 'starter',
        billingStatus: 'active',
        mpPaymentId: String(mpId),
        planActivatedAt: now(),
        updatedAt: now()
      });
      await db.collection('tenants').doc(tenantId).collection('billing_history').add({
        type: 'payment_approved', plan,
        paymentId: String(mpId),
        amount: transaction_amount,
        status: 'approved', approvedAt: now()
      });
      if (process.env.NODE_ENV !== 'production') console.warn(`[BILLING] ✅ Tenant "${tenantId}" → plano ${plan}`);
    }
    if (status === 'rejected' || status === 'cancelled') {
      await db.collection('tenants').doc(tenantId).update({
        billingStatus: status, updatedAt: now()
      });
    }
    return { ok: true, tenantId, plan, status };
  }

  if (topic === 'merchant_order') {
    const order = await mpGet(`/merchant_orders/${mpId}`);
    const paidAmount = (order.payments || [])
      .filter(p => p.status === 'approved')
      .reduce((s, p) => s + p.transaction_amount, 0);

    if (paidAmount >= order.total_amount && order.total_amount > 0) {
      const [tenantId, plan] = (order.external_reference || '').split(':');
      if (tenantId) {
        await db.collection('tenants').doc(tenantId).update({
          plan: plan || 'starter',
          billingStatus: 'active',
          planActivatedAt: now(),
          updatedAt: now()
        });
      }
    }
    return { ok: true };
  }

  return { ok: true, skipped: true };
}

async function manualApprove(tenantId, plan, masterUid, notes) {
  if (!PLANS[plan]) throw new Error('Plano inválido');
  await db.collection('tenants').doc(tenantId).update({
    plan, billingStatus: 'active',
    planActivatedAt: now(), updatedAt: now()
  });
  await db.collection('tenants').doc(tenantId).collection('billing_history').add({
    type: 'manual_approval', plan,
    approvedBy: masterUid, notes: notes || '', approvedAt: now()
  });
  await db.collection('manual_approvals').add({
    tenantId, plan, approvedBy: masterUid,
    notes: notes || '', approvedAt: now()
  });
  return { ok: true, tenantId, plan };
}

async function cancelPlan(tenantId) {
  await db.collection('tenants').doc(tenantId).update({
    plan: 'free', billingStatus: 'cancelled',
    cancelledAt: now(), updatedAt: now()
  });
  await db.collection('tenants').doc(tenantId).collection('billing_history').add({
    type: 'plan_cancelled', plan: 'free', cancelledAt: now()
  });
  return { ok: true };
}

async function getBillingStatus(tenantId) {
  const [tenantDoc, historySnap] = await Promise.all([
    db.collection('tenants').doc(tenantId).get(),
    db.collection('tenants').doc(tenantId).collection('billing_history')
      .orderBy('createdAt', 'desc').limit(10).get()
  ]);
  if (!tenantDoc.exists) throw new Error('Tenant não encontrado');
  const data    = tenantDoc.data();
  const history = historySnap.docs.map(d => ({ id: d.id, ...d.data() }));
  return {
    plan:            data.plan || 'free',
    billingStatus:   data.billingStatus || 'active',
    planActivatedAt: data.planActivatedAt?.toDate?.()?.toISOString() || null,
    history,
    plans: {
      free:       { price: 'R$0',          features: ['20 msgs/dia','3 agentes','CRM básico'] },
      starter:    { price: 'R$97/mês',     features: ['200 msgs/dia','10 agentes','Swarm','Pipeline'] },
      pro:        { price: 'R$297/mês',    features: ['1000 msgs/dia','Agentes ilimitados','AutoDev','RAG 500 docs'] },
      enterprise: { price: 'Sob consulta', features: ['Ilimitado','SLA dedicado','Onboarding','White-label'] }
    }
  };
}

// ── Stripe Payment Link ──────────────────────────────────────────────────────
async function createStripeLink({ amount, currency = 'usd', email, description, tenantId }) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    // Retorna aviso claro sem quebrar
    return { ok: false, configured: false, message: 'STRIPE_SECRET_KEY não configurado. Adicione nas variáveis de ambiente da Netlify.' };
  }
  const _fetch = globalThis.fetch.bind(globalThis); // Node 20+ native fetch

  // Criar Price object
  const priceRes = await _fetch('https://api.stripe.com/v1/prices', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      currency, unit_amount: Math.round(parseFloat(amount) * 100),
      'product_data[name]': description || 'NEXIA OS License'
    }).toString()
  });
  const price = await priceRes.json();
  if (price.error) throw new Error(price.error.message);

  // Criar Payment Link
  const linkRes = await _fetch('https://api.stripe.com/v1/payment_links', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ 'line_items[0][price]': price.id, 'line_items[0][quantity]': '1' }).toString()
  });
  const link = await linkRes.json();
  if (link.error) throw new Error(link.error.message);

  // Salvar no Firestore
  await db.collection('tenants').doc(tenantId || 'global').collection('payments').add({
    method: 'stripe', status: 'pending', amount: parseFloat(amount), currency,
    description, payerEmail: email, paymentLink: link.url,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { ok: true, url: link.url, priceId: price.id };
}

exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // Webhook MP — sem auth obrigatória (GET com ?topic= ou POST com body.type)
  const qs = event.queryStringParameters || {};
  const isWebhook = qs.topic || qs.id ||
    (() => { try { const b = JSON.parse(event.body||'{}'); return !!b.type; } catch { return false; } })();

  if (isWebhook) {
    try {
      const body   = (() => { try { return JSON.parse(event.body||'{}'); } catch { return {}; } })();
      const result = await processWebhook(body, qs);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    } catch (err) {
      console.error('[BILLING] Webhook error:', err.message);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: err.message }) };
    }
  }

  const guardErr = await guard(event, 'billing');
  if (guardErr) return guardErr;

  // GUARD: Firebase obrigatório para billing (exceto webhooks já tratados acima)
  if (!db) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Serviço de billing temporariamente indisponível. Tente novamente em instantes.' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, tenantId, userId, plan, email, name, cpf, masterUid, notes } = body;

    if (action === 'checkout') return { statusCode: 200, headers, body: JSON.stringify(await createCheckout(tenantId, userId, plan, email, name)) };
    if (action === 'pix')         return { statusCode: 200, headers, body: JSON.stringify(await createPix(tenantId, userId, plan, email, cpf)) };
    if (action === 'status')      return { statusCode: 200, headers, body: JSON.stringify(await getBillingStatus(tenantId)) };
    if (action === 'cancel')      return { statusCode: 200, headers, body: JSON.stringify(await cancelPlan(tenantId)) };
    if (action === 'manual')      return { statusCode: 200, headers, body: JSON.stringify(await manualApprove(tenantId, plan, masterUid, notes)) };
    if (action === 'stripe_link') return { statusCode: 200, headers, body: JSON.stringify(await createStripeLink(body)) };

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ação não reconhecida' }) };
  } catch (err) {
    console.error('[BILLING] ❌', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
