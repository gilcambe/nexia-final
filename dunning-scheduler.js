'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS — DUNNING SCHEDULER v1.0                               ║
 * ║  Netlify Scheduled Function — roda todo dia às 09:00 BRT         ║
 * ║  Rota de cobrança: Dia 1 aviso → Dia 3 urgente → Dia 5 bloqueio  ║
 * ╚══════════════════════════════════════════════════════════════════╝
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

// ── Envia notificação via WhatsApp (se configurado) ou e-mail fallback ──
async function sendDunningMessage(tenant, daysPastDue, plan) {
  const phone = tenant.whatsappNumber || tenant.phone;
  const email = tenant.ownerEmail || tenant.email;
  const name  = tenant.name || tenant.id;
  const appUrl = process.env.NEXIA_APP_URL || 'https://nexia.app';

  const messages = {
    1: {
      subject: `⚠️ Fatura NEXIA venceu — ${name}`,
      text: `Olá ${name}! 👋\n\nSua fatura do NEXIA OS (Plano ${plan}) venceu ontem.\n\nRegularize agora para continuar usando todos os recursos:\n${appUrl}/nexia/nexia-pay.html\n\nQualquer dúvida, estamos aqui! 🙏`,
      whatsapp: `⚠️ Olá ${name}! Sua fatura NEXIA venceu ontem. Regularize em: ${appUrl}/nexia/nexia-pay.html`
    },
    3: {
      subject: `🔴 3 dias em atraso — NEXIA OS vai ser suspenso`,
      text: `Olá ${name},\n\nSua conta NEXIA OS está há 3 dias sem pagamento. Se não regularizar em 48h, o acesso será suspenso automaticamente.\n\nPague agora: ${appUrl}/nexia/nexia-pay.html\n\nApós o pagamento, o acesso é reativado em 2 minutos. ✅`,
      whatsapp: `🔴 ${name}, sua conta NEXIA vai ser SUSPENSA em 48h por falta de pagamento. Pague agora: ${appUrl}/nexia/nexia-pay.html`
    },
    5: {
      subject: `🚫 Conta NEXIA suspensa — ${name}`,
      text: `Olá ${name},\n\nSua conta NEXIA OS foi suspensa por falta de pagamento (5 dias em atraso).\n\nPague agora para reativar em 2 minutos: ${appUrl}/nexia/nexia-pay.html\n\nSeus dados estão seguros e serão preservados por 90 dias.`,
      whatsapp: `🚫 ${name}, sua conta NEXIA foi SUSPENSA. Pague para reativar: ${appUrl}/nexia/nexia-pay.html`
    }
  };

  const msg = messages[daysPastDue] || messages[5];
  const results = { email: false, whatsapp: false };

  // WhatsApp via WhatsApp Business API (se configurado)
  if (phone && process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID) {
    try {
      const res = await fetch(`https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone.replace(/\D/g, ''),
          type: 'text',
          text: { preview_url: false, body: msg.whatsapp }
        })
      });
      results.whatsapp = res.ok;
    } catch (e) { console.warn('[DUNNING] WhatsApp:', e.message); }
  }

  // E-mail via Resend (se configurado) — fallback simples
  if (email && process.env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `NEXIA OS <noreply@${process.env.NEXIA_EMAIL_DOMAIN || 'nexia.app'}>`,
          to: [email],
          subject: msg.subject,
          text: msg.text
        })
      });
      results.email = res.ok;
    } catch (e) { console.warn('[DUNNING] Email:', e.message); }
  }

  return results;
}

// ── Suspende tenant no Firestore + kill_switch ──────────────────────
async function suspendTenant(tenantId) {
  const batch = db.batch();
  batch.update(db.collection('tenants').doc(tenantId), {
    status: 'suspended',
    suspendedAt: admin.firestore.FieldValue.serverTimestamp(),
    suspendReason: 'dunning_auto'
  });
  batch.set(db.collection('kill_switch').doc(tenantId), {
    active: true,
    reason: 'inadimplência',
    activatedAt: admin.firestore.FieldValue.serverTimestamp(),
    activatedBy: 'dunning-scheduler'
  });
  await batch.commit();
}


// ── Verifica se já foi enviado aviso/ação hoje para este tenant ──────────────
async function alreadyActedToday(tenantId, day) {
  if (!db) return false;
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const snap = await db.collection('tenants').doc(tenantId)
      .collection('dunning_log')
      .where('day', '==', day)
      .where('ts', '>=', admin.firestore.Timestamp.fromDate(todayStart))
      .limit(1)
      .get();
    return !snap.empty;
  } catch (e) {
    console.warn('[DUNNING] idempotency check failed:', e.message);
    return false; // fail-open na verificação de idempotência (não bloquear por erro de leitura)
  }
}

// ── Handler principal (scheduled function) ─────────────────────────
exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': (process.env.NEXIA_APP_URL ? process.env.NEXIA_APP_URL.split(',')[0].trim() : '*') };

  // Permite chamada manual via POST com autorização
  if (event.httpMethod === 'POST') {
    const auth = event.headers?.authorization || '';
    const dunningSecret = process.env.DUNNING_SECRET;
    if (!dunningSecret) {
      console.error('[DUNNING] DUNNING_SECRET não configurado — chamada manual bloqueada por segurança');
      return { statusCode: 503, headers, body: JSON.stringify({ error: 'Service not configured' }) };
    }
    if (auth !== `Bearer ${dunningSecret}`) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }

  const today = new Date();
  const results = { processed: 0, warned: 0, suspended: 0, errors: [] };

  try {
    // Busca todos os tenants com status active ou atrasado
    const tenantsSnap = await db.collection('tenants')
      .where('status', 'in', ['active', 'ativo', 'overdue'])
      .get();

    for (const doc of tenantsSnap.docs) {
      const tenant = { id: doc.id, ...doc.data() };

      // Verifica se tem data de vencimento configurada
      const dueDate = tenant.nextBillingDate || tenant.billingDueDate;
      if (!dueDate) continue;

      const due = dueDate.toDate ? dueDate.toDate() : new Date(dueDate);
      const daysPastDue = Math.floor((today - due) / (1000 * 60 * 60 * 24));

      // Plano free não entra no dunning
      const plan = tenant.subscription?.plan || tenant.plan || 'free';
      if (plan === 'free' || plan === 'master') continue;

      results.processed++;

      try {
        if (daysPastDue === 1 || daysPastDue === 3) {
          // Aviso — verifica idempotência (evita duplicatas se scheduler rodar 2x)
          const alreadySent = await alreadyActedToday(tenant.id, daysPastDue);
          if (alreadySent) { results.processed--; continue; }
          const sent = await sendDunningMessage(tenant, daysPastDue, plan);
          await db.collection('tenants').doc(tenant.id).collection('dunning_log').add({
            day: daysPastDue, action: 'warning', sent, plan,
            ts: admin.firestore.FieldValue.serverTimestamp()
          });
          results.warned++;
        } else if (daysPastDue >= 5 && tenant.status !== 'suspended') {
          // Suspende — verifica idempotência
          const alreadySuspended = await alreadyActedToday(tenant.id, 5);
          if (alreadySuspended) { results.processed--; continue; }
          await suspendTenant(tenant.id);
          await sendDunningMessage(tenant, 5, plan);
          await db.collection('tenants').doc(tenant.id).collection('dunning_log').add({
            day: daysPastDue, action: 'suspended', plan,
            ts: admin.firestore.FieldValue.serverTimestamp()
          });
          results.suspended++;
        }

        // Marca como overdue se passou do vencimento
        if (daysPastDue > 0 && tenant.status === 'active') {
          await db.collection('tenants').doc(tenant.id).update({ status: 'overdue' });
        }
      } catch (e) {
        results.errors.push({ tenant: tenant.id, error: e.message });
      }
    }

    // Loga resultado no Firestore
    await db.collection('audit_log_global').add({ ttl: admin.firestore.Timestamp.fromMillis(Date.now() + 2592000000),
      type: 'dunning_run', ...results,
      ts: admin.firestore.FieldValue.serverTimestamp()
    });

    if (process.env.NODE_ENV !== 'production') console.error('[DUNNING] Run complete:', results);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...results }) };

  } catch (err) {
    console.error('[DUNNING] Fatal:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
