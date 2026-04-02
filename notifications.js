'use strict';

/**
/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — NOTIFICATIONS v8.3                      ║
 * ║  In-app notifications · Bell · Mark as read          ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Collection: notifications/{userId}/items/{id}
 *
 * GET  /api/notifications?userId=x&tenantId=y  → lista (unread primeiro)
 * POST /api/notifications  { action, ... }
 *   action = "send"    → { userId, tenantId, title, body, type, link }
 *   action = "read"    → { userId, notifId }
 *   action = "readAll" → { userId }
 *   action = "clear"   → { userId }
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

const NOTIF_TYPES = {
  info:    { icon: 'ri-information-line',      color: '#00E5FF' },
  success: { icon: 'ri-checkbox-circle-line',  color: '#2ED080' },
  warning: { icon: 'ri-error-warning-line',    color: '#F59E0B' },
  error:   { icon: 'ri-close-circle-line',     color: '#FF3D5A' },
  ai:      { icon: 'ri-brain-line',            color: '#A855F7' },
  crm:     { icon: 'ri-contacts-line',         color: '#00E5FF' },
  task:    { icon: 'ri-task-line',             color: '#00E5FF' },
  finance: { icon: 'ri-money-dollar-circle-line', color: '#2ED080' }
};

// ── Envia notificação ─────────────────────────────────────────
async function send(userId, tenantId, title, body, type = 'info', link = null, meta = {}) {
  const notif = {
    userId, tenantId, title,
    body:    body || '',
    type:    NOTIF_TYPES[type] ? type : 'info',
    icon:    NOTIF_TYPES[type]?.icon  || NOTIF_TYPES.info.icon,
    color:   NOTIF_TYPES[type]?.color || NOTIF_TYPES.info.color,
    link,
    meta,
    read:    false,
    createdAt: now()
  };
  const ref = await db.collection('notifications').doc(userId).collection('items').add(notif);

  // Incrementa badge counter no perfil do usuário
  await db.collection('users').doc(userId).update({
    unreadNotifs: admin.firestore.FieldValue.increment(1)
  }).catch(() => {});

  return { id: ref.id };
}

// ── Marca como lida ────────────────────────────────────────────
async function markRead(userId, notifId) {
  const ref  = db.collection('notifications').doc(userId).collection('items').doc(notifId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().read) return { id: notifId, already: true };

  await ref.update({ read: true, readAt: now() });
  await db.collection('users').doc(userId).update({
    unreadNotifs: admin.firestore.FieldValue.increment(-1)
  }).catch(() => {});

  return { id: notifId, ok: true };
}

// ── Marca todas como lidas ─────────────────────────────────────
async function markAllRead(userId) {
  const snap = await db.collection('notifications').doc(userId)
    .collection('items').where('read', '==', false).get();

  if (snap.empty) return { count: 0 };

  const batch = db.batch();
  snap.docs.forEach(d => batch.update(d.ref, { read: true, readAt: now() }));
  await batch.commit();

  await db.collection('users').doc(userId).update({ unreadNotifs: 0 }).catch(() => {});
  return { count: snap.size };
}

// ── Lista notificações ─────────────────────────────────────────
async function list(userId, limit = 30) {
  const snap = await db.collection('notifications').doc(userId)
    .collection('items')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  const items  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const unread = items.filter(n => !n.read).length;
  return { items, unread, total: items.length };
}

// ── Handler ────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = makeHeaders(event);
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const guardErr = await guard(event, 'notifications', { skipTenant: true });
  if (guardErr) return guardErr;

  try {
    if (event.httpMethod === 'GET') {
      const { userId, limit } = event.queryStringParameters || {};
      if (!userId) throw new Error('userId obrigatório');
      const result = await list(userId, parseInt(limit) || 30);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    const { action, userId, tenantId, title, body: bodyText, type, link, meta, notifId } = JSON.parse(event.body || '{}');
    if (!userId) throw new Error('userId obrigatório');

    if (action === 'send')    return { statusCode: 200, headers, body: JSON.stringify(await send(userId, tenantId, title, bodyText, type, link, meta)) };
    if (action === 'read')    return { statusCode: 200, headers, body: JSON.stringify(await markRead(userId, notifId)) };
    if (action === 'readAll') return { statusCode: 200, headers, body: JSON.stringify(await markAllRead(userId)) };

    throw new Error(`Ação desconhecida: ${action}`);
  } catch (err) {
    console.error('[NOTIFICATIONS] ❌', err.message);
    return { statusCode: 400, headers, body: JSON.stringify({ error: err.message }) };
  }
};

exports.send       = send;
exports.markRead   = markRead;
exports.markAllRead = markAllRead;
