'use strict';

/**
/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — EVENT PROCESSOR v8.2                    ║
 * ║  Triggers automáticos via fila Firestore            ║
 * ║  POST /api/events  →  processa fila event_queue     ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Fluxo:
 *  1. Qualquer module chama  emitEvent(type, payload, tenantId)
 *  2. Evento cai em  event_queue/{id}  com status "pending"
 *  3. Esta function processa a fila e dispara os handlers
 *  4. Evento fica com status "done" | "error"
 *
 * Triggers implementados:
 *  client:created   → cria tarefa de follow-up no CRM
 *  task:created     → registra log de criação
 *  finance:created  → atualiza saldo consolidado do tenant
 *  cortex:action    → dispara webhook externo (se configurado)
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
const now = () => admin.firestore.FieldValue.serverTimestamp();

const { guard, makeHeaders} = require('./middleware');
const notifModule = require('./notifications');

// ── Máximo de eventos por execução (evita timeout Netlify) ────
const MAX_BATCH = 20;

// ─────────────────────────────────────────────────────────────
// HANDLERS DE TRIGGER
// ─────────────────────────────────────────────────────────────

// cliente criado → tarefa de follow-up automática
async function onClientCreated(payload, tenantId) {
  const { id: clientId, nome = 'Cliente', email = '' } = payload;

  const task = {
    titulo:      `Follow-up: ${nome}`,
    descricao:   `Cliente criado automaticamente. Email: ${email}`,
    responsavel: 'Equipe de Vendas',
    prioridade:  'alta',
    status:      'pending',
    clienteId:   clientId,
    origem:      'EVENT_SYSTEM',
    tenantId,
    createdBy:   'CORTEX_AI',
    createdAt:   now(),
    updatedAt:   now()
  };

  const ref = await db.collection('tenants').doc(tenantId).collection('tasks').add(task);
  if (process.env.NODE_ENV !== 'production') console.warn(`[EVENT] follow-up criado: tasks/${ref.id} → cliente ${clientId}`);

  // Notifica owner do tenant
  const tenantSnap = await db.collection('tenants').doc(tenantId).get().catch(()=>null);
  if (tenantSnap?.exists) {
    const owner = tenantSnap.data().ownerUid;
    if (owner) {
      notifModule.send(owner, tenantId,
        `Novo lead: ${nome}`,
        `Follow-up criado automaticamente. Verifique suas tarefas.`,
        'crm', '/nexia/tenant-hub.html'
      ).catch(()=>{});
    }
  }

  return { taskId: ref.id };
}

// tarefa criada → log estruturado
async function onTaskCreated(payload, tenantId) {
  await db.collection('tenants').doc(tenantId).collection('cortex_logs').add({ ttl: admin.firestore.Timestamp.fromMillis(Date.now() + 2592000000),
    type:    'task_auto_log',
    taskId:  payload.id,
    titulo:  payload.titulo,
    origem:  payload.origem,
    tenantId,
    ts:      now()
  });
  return { logged: true };
}

// finance criado → recalcula saldo consolidado do tenant
async function onFinanceCreated(payload, tenantId) {
  const snap = await db.collection('tenants').doc(tenantId)
    .collection('finance')
    .where('_deleted', '!=', true)
    .get();

  let receita = 0, despesa = 0;
  snap.docs.forEach(d => {
    const f = d.data();
    const v = Number(f.valor) || 0;
    if (f.tipo === 'receita') receita += v;
    else                      despesa += v;
  });

  await db.collection('tenants').doc(tenantId).set({
    saldo:       receita - despesa,
    totalReceita: receita,
    totalDespesa: despesa,
    updatedAt:   now()
  }, { merge: true });

  if (process.env.NODE_ENV !== 'production') console.warn(`[EVENT] saldo recalculado: +${receita} -${despesa} = ${receita - despesa}`);
  return { saldo: receita - despesa };
}

// cortex:action → webhook externo se configurado
async function onCortexAction(payload, tenantId) {
  const configSnap = await db.collection('tenants').doc(tenantId)
    .collection('config').doc('webhooks').get().catch(() => null);

  if (!configSnap?.exists) return { skipped: 'no webhook config' };

  const { actionWebhook } = configSnap.data();
  if (!actionWebhook) return { skipped: 'no actionWebhook url' };

  try {
    const r = await fetch(actionWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'cortex:action', payload, tenantId, ts: Date.now() })
    });
    return { webhookStatus: r.status };
  } catch (e) {
    return { webhookError: e.message };
  }
}

// ── Roteador de triggers ──────────────────────────────────────
const TRIGGERS = {
  'client:created':  onClientCreated,
  'task:created':    onTaskCreated,
  'finance:created': onFinanceCreated,
  'cortex:action':   onCortexAction
};

// ─────────────────────────────────────────────────────────────
// EMITIR EVENTO (importado por outros módulos)
// ─────────────────────────────────────────────────────────────
async function emitEvent(type, payload, tenantId, meta = {}) {
  const ref = await db.collection('event_queue').add({
    type,
    payload,
    tenantId,
    meta,
    status:    'pending',
    retries:   0,
    createdAt: now()
  });
  return ref.id;
}

// ─────────────────────────────────────────────────────────────
// PROCESSAR FILA
// ─────────────────────────────────────────────────────────────
async function processQueue(tenantId) {
  let q = db.collection('event_queue')
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'asc')
    .limit(MAX_BATCH);

  if (tenantId) q = q.where('tenantId', '==', tenantId);

  const snap = await q.get();
  if (snap.empty) return { processed: 0 };

  const results = [];

  for (const doc of snap.docs) {
    const ev  = doc.data();
    const ref = doc.ref;

    // Marca como processando (optimistic lock)
    await ref.update({ status: 'processing', startedAt: now() });

    const handler = TRIGGERS[ev.type];

    if (!handler) {
      await ref.update({ status: 'done', result: { skipped: 'no handler' }, doneAt: now() });
      results.push({ id: doc.id, type: ev.type, status: 'skipped' });
      continue;
    }

    try {
      const result = await handler(ev.payload || {}, ev.tenantId);
      await ref.update({ status: 'done', result, doneAt: now() });
      results.push({ id: doc.id, type: ev.type, status: 'done', result });
    } catch (e) {
      const retries = (ev.retries || 0) + 1;
      const status  = retries >= 3 ? 'failed' : 'pending'; // requeue se < 3 tentativas
      await ref.update({ status, error: e.message, retries, lastErrorAt: now() });
      results.push({ id: doc.id, type: ev.type, status: 'error', error: e.message, retries });
      console.error(`[EVENT] Erro no handler ${ev.type}:`, e.message);
    }
  }

  if (process.env.NODE_ENV !== 'production') console.warn(`[EVENT] Processados ${results.length} eventos`);
  return { processed: results.length, results };
}

// ─────────────────────────────────────────────────────────────
// HANDLER NETLIFY
// ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = makeHeaders(event);
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const guardErr = await guard(event, 'event-processor', { skipTenant: true });
  if (guardErr) return guardErr;

  try {
    const body     = JSON.parse(event.body || '{}');
    const tenantId = body.tenantId || null;

    // Permite emitir + processar em uma chamada
    if (body.emit) {
      const { type, payload, meta } = body.emit;
      if (!type) throw new Error('emit.type é obrigatório');
      const eventId = await emitEvent(type, payload || {}, tenantId, meta || {});
      const result  = await processQueue(tenantId);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, eventId, ...result }) };
    }

    // Só processa fila
    const result = await processQueue(tenantId);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };

  } catch (err) {
    console.error('[EVENT-PROCESSOR] ❌', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

exports.emitEvent   = emitEvent;
exports.processQueue = processQueue;
