'use strict';

/**
/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — TENANT ADMIN v8.3                       ║
 * ║  Onboarding · Planos · Limites · Membros             ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * GET  /api/tenant?tenantId=x         → info completa do tenant
 * POST /api/tenant  { action, ... }   → criar/atualizar/convidar
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
const { guard, makeHeaders} = require('./middleware');

// ── Planos disponíveis ─────────────────────────────────────────
const PLANS = {
  free: {
    name:         'Free',
    maxMembers:   1,
    maxClients:   50,
    maxTasks:     100,
    maxCortexDay: 20,    // msgs/dia no Cortex
    maxAgents:    3,
    swarmEnabled: false,
    price:        0
  },
  starter: {
    name:         'Starter',
    maxMembers:   5,
    maxClients:   500,
    maxTasks:     1000,
    maxCortexDay: 200,
    maxAgents:    10,
    swarmEnabled: true,
    price:        97
  },
  pro: {
    name:         'Pro',
    maxMembers:   20,
    maxClients:   5000,
    maxTasks:     -1,    // ilimitado
    maxCortexDay: 1000,
    maxAgents:    -1,
    swarmEnabled: true,
    price:        297
  },
  enterprise: {
    name:         'Enterprise',
    maxMembers:   -1,
    maxClients:   -1,
    maxTasks:     -1,
    maxCortexDay: -1,
    maxAgents:    -1,
    swarmEnabled: true,
    price:        -1      // sob consulta
  }
};

// ── Cria tenant novo (onboarding) ──────────────────────────────
async function createTenant(data) {
  const { slug, name, ownerUid, ownerEmail, plan = 'free' } = data;
  if (!slug || !name || !ownerUid) throw new Error('slug, name e ownerUid são obrigatórios');
  if (!/^[a-z0-9-]{3,30}$/.test(slug)) throw new Error('slug deve ter 3-30 chars (a-z, 0-9, -)');

  const existing = await db.collection('tenants').doc(slug).get();
  if (existing.exists) throw new Error(`Tenant "${slug}" já existe`);

  const planData = PLANS[plan] || PLANS.free;
  const batch    = db.batch();

  // Documento principal do tenant
  batch.set(db.collection('tenants').doc(slug), {
    slug, name,
    ownerUid,
    ownerEmail: ownerEmail || '',
    plan,
    planLimits:  planData,
    status:      'active',
    membersCount: 1,
    createdAt:   now(),
    updatedAt:   now(),
    billing: {
      status:      'trial',
      trialEndsAt: new Date(Date.now() + 14 * 86400_000).toISOString(),
      customerId:  null
    },
    settings: {
      language:   'pt-BR',
      timezone:   'America/Sao_Paulo',
      webhookUrl: null
    }
  });

  // Adiciona owner como membro admin
  batch.set(db.collection('tenants').doc(slug).collection('members').doc(ownerUid), {
    uid:       ownerUid,
    email:     ownerEmail || '',
    role:      'admin',
    joinedAt:  now(),
    status:    'active'
  });

  // Atualiza perfil do owner com tenantSlug
  batch.update(db.collection('users').doc(ownerUid), {
    tenantSlug: slug,
    updatedAt:  now()
  });

  await batch.commit();
  return { slug, name, plan, planLimits: planData };
}

// ── Verifica limite do plano ───────────────────────────────────
async function checkLimit(tenantId, resource) {
  const snap = await db.collection('tenants').doc(tenantId).get();
  if (!snap.exists) return { ok: true }; // fallback permissivo

  const { plan = 'free', planLimits } = snap.data();
  const limits = planLimits || PLANS[plan] || PLANS.free;

  const limitMap = {
    clients:   { field: 'maxClients',   collection: 'clients' },
    tasks:     { field: 'maxTasks',     collection: 'tasks' },
    agents:    { field: 'maxAgents',    collection: null },
    members:   { field: 'maxMembers',   collection: 'members' },
    cortexDay: { field: 'maxCortexDay', collection: null }
  };

  const cfg = limitMap[resource];
  if (!cfg) return { ok: true };

  const max = limits[cfg.field] ?? -1;
  if (max === -1) return { ok: true, unlimited: true };

  let current = 0;
  if (cfg.collection) {
    const countSnap = await db.collection('tenants').doc(tenantId)
      .collection(cfg.collection).where('_deleted', '!=', true)
      .count().get().catch(() => null);
    current = countSnap?.data().count ?? 0;
  } else if (resource === 'cortexDay') {
    // Conta msgs do Cortex hoje
    const today = new Date(); today.setHours(0,0,0,0);
    const countSnap = await db.collection('tenants').doc(tenantId)
      .collection('cortex_logs')
      .where('ts', '>=', admin.firestore.Timestamp.fromDate(today))
      .count().get().catch(() => null);
    current = countSnap?.data().count ?? 0;
  }

  return {
    ok:      current < max,
    current,
    max,
    plan,
    resource,
    message: current >= max ? `Limite do plano ${plan} atingido (${current}/${max} ${resource})` : null
  };
}

// ── Convida membro ─────────────────────────────────────────────
async function inviteMember(tenantId, email, role = 'member', invitedBy) {
  const tenantSnap = await db.collection('tenants').doc(tenantId).get();
  if (!tenantSnap.exists) throw new Error('Tenant não encontrado');

  const limit = await checkLimit(tenantId, 'members');
  if (!limit.ok) throw new Error(limit.message);

  // Cria convite pendente
  const inviteRef = await db.collection('tenants').doc(tenantId)
    .collection('invites').add({
      email,
      role,
      invitedBy,
      status:    'pending',
      token:     Math.random().toString(36).slice(2) + Date.now().toString(36),
      expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      createdAt: now()
    });

  return { inviteId: inviteRef.id, email, role };
}

// ── Atualiza plano ─────────────────────────────────────────────
async function updatePlan(tenantId, plan) {
  if (!PLANS[plan]) throw new Error(`Plano inválido: ${plan}`);
  await db.collection('tenants').doc(tenantId).update({
    plan,
    planLimits: PLANS[plan],
    updatedAt:  now()
  });
  return { tenantId, plan, planLimits: PLANS[plan] };
}

// ── Info completa do tenant ────────────────────────────────────
async function getTenantInfo(tenantId) {
  const [tenantSnap, membersSnap, clientCount, taskCount] = await Promise.all([
    db.collection('tenants').doc(tenantId).get(),
    db.collection('tenants').doc(tenantId).collection('members').get(),
    db.collection('tenants').doc(tenantId).collection('clients').count().get().catch(() => null),
    db.collection('tenants').doc(tenantId).collection('tasks').count().get().catch(() => null)
  ]);

  if (!tenantSnap.exists) throw new Error('Tenant não encontrado');

  return {
    ...tenantSnap.data(),
    members: membersSnap.docs.map(d => ({ uid: d.id, ...d.data() })),
    stats: {
      clients: clientCount?.data().count ?? 0,
      tasks:   taskCount?.data().count   ?? 0,
      members: membersSnap.size
    },
    plans: PLANS
  };
}

// ── Handler ────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = makeHeaders(event);
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const guardErr = await guard(event, 'tenant-admin', { skipTenant: true });
  if (guardErr) return guardErr;

  try {
    if (event.httpMethod === 'GET') {
      const qs = event.queryStringParameters || {};

      // ── PABX CRM Lookup por telefone (/api/crm/lookup?phone=...) ──
      if (qs.phone) {
        if (!db) return { statusCode: 503, headers, body: JSON.stringify({ error: 'Firebase indisponível' }) };
        const phone = qs.phone.replace(/\D/g, ''); // normaliza: só dígitos
        const snap = await db.collectionGroup('clients')
          .where('telefone', '==', phone).limit(1).get();
        if (snap.empty) {
          // tenta com formatação alternativa (com +55)
          const snap2 = await db.collectionGroup('clients')
            .where('telefone', '==', '+' + phone).limit(1).get();
          if (snap2.empty) return { statusCode: 404, headers, body: JSON.stringify({ found: false, phone }) };
          const doc2 = snap2.docs[0];
          return { statusCode: 200, headers, body: JSON.stringify({ found: true, id: doc2.id, ...doc2.data() }) };
        }
        const doc = snap.docs[0];
        return { statusCode: 200, headers, body: JSON.stringify({ found: true, id: doc.id, ...doc.data() }) };
      }

      // ── Info completa do tenant (/api/tenant?tenantId=...) ──
      const { tenantId } = qs;
      if (!tenantId) throw new Error('tenantId obrigatório');
      const info = await getTenantInfo(tenantId);
      return { statusCode: 200, headers, body: JSON.stringify(info) };
    }

    const { action, ...payload } = JSON.parse(event.body || '{}');

    if (action === 'create')       return { statusCode: 200, headers, body: JSON.stringify(await createTenant(payload)) };
    if (action === 'invite')       return { statusCode: 200, headers, body: JSON.stringify(await inviteMember(payload.tenantId, payload.email, payload.role, payload.invitedBy)) };
    if (action === 'updatePlan')   return { statusCode: 200, headers, body: JSON.stringify(await updatePlan(payload.tenantId, payload.plan)) };
    if (action === 'checkLimit')   return { statusCode: 200, headers, body: JSON.stringify(await checkLimit(payload.tenantId, payload.resource)) };

    throw new Error(`Ação desconhecida: ${action}`);
  } catch (err) {
    console.error('[TENANT-ADMIN] ❌', err.message);
    return { statusCode: 400, headers, body: JSON.stringify({ error: err.message }) };
  }
};

exports.checkLimit  = checkLimit;
exports.PLANS       = PLANS;
exports.createTenant = createTenant;
