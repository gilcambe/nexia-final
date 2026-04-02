// ═══════════════════════════════════════════════════════════════
// NEXIA Sentinel IoT — Smart Lock Management
// POST /api/sentinel
// Integra com TTLock API v3 para fechaduras inteligentes
// Actions: list_locks, lock, unlock, add_passcode, delete_passcode,
//          get_records, get_battery, sync_time, list_passcodes,
//          add_card, webhook
// ═══════════════════════════════════════════════════════════════
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


const TTLOCK_BASE = 'https://euapi.ttlock.com/v3'; // EU endpoint (global)

// ── TTLock API caller ───────────────────────────────────────────
async function ttCall(path, params = {}, tenantCfg = {}) {
  const clientId = tenantCfg.clientId || process.env.TTLOCK_CLIENT_ID;
  const accessToken = tenantCfg.accessToken || process.env.TTLOCK_ACCESS_TOKEN;

  if (!clientId || !accessToken) throw new Error('TTLock credentials not configured');

  const body = new URLSearchParams({
    clientId,
    accessToken,
    date: Date.now().toString(),
    ...params
  });

  const res = await fetch(`${TTLOCK_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  const data = await res.json();

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`TTLock error ${data.errcode}: ${data.errmsg || 'Unknown error'}`);
  }

  return data;
}

// ── Get tenant TTLock config ────────────────────────────────────
async function getTenantCfg(tenantId) {
  const doc = await db.collection('tenants').doc(tenantId).get();
  return doc.data()?.ttlockConfig || {};
}

const { requireBearerAuth, makeHeaders} = require('./middleware');

exports.handler = async (event) => {
  const headers = makeHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  // CORRIGIDO v38: controle de acesso IoT — autenticação obrigatória
    const _authErr = await requireBearerAuth(event);
  if (_authErr) return _authErr;
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, tenantId } = body;

    if (!action || !tenantId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'action and tenantId required' }) };

    const tenantCfg = await getTenantCfg(tenantId);

    // ── ACTION: list_locks ─────────────────────────────────────
    if (action === 'list_locks') {
      const { pageNo = 1, pageSize = 20 } = body;
      const data = await ttCall('/lock/list', { pageNo, pageSize }, tenantCfg);

      // Cache in Firestore
      if (data.list) {
        const batch = db.batch();
        data.list.forEach(lock => {
          const ref = db.collection('tenants').doc(tenantId).collection('iot_locks').doc(String(lock.lockId));
          batch.set(ref, {
            ...lock,
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        });
        await batch.commit();
      }

      return { statusCode: 200, headers, body: JSON.stringify({ locks: data.list || [], total: data.totalNum || 0 }) };
    }

    // ── ACTION: unlock ─────────────────────────────────────────
    if (action === 'unlock') {
      const { lockId, reason } = body;
      if (!lockId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'lockId required' }) };

      const data = await ttCall('/lock/unlock', { lockId }, tenantCfg);

      // Log access
      await db.collection('tenants').doc(tenantId).collection('iot_access_log').add({
        lockId,
        action: 'unlock',
        method: 'remote',
        reason: reason || 'Remote unlock via NEXIA',
        operator: body.operatorName || 'Sistema',
        timestamp: FieldValue.serverTimestamp(),
        success: true
      });

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, lockId, status: 'unlocked' }) };
    }

    // ── ACTION: lock ───────────────────────────────────────────
    if (action === 'lock') {
      const { lockId } = body;
      if (!lockId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'lockId required' }) };

      const data = await ttCall('/lock/lock', { lockId }, tenantCfg);

      await db.collection('tenants').doc(tenantId).collection('iot_access_log').add({
        lockId,
        action: 'lock',
        method: 'remote',
        operator: body.operatorName || 'Sistema',
        timestamp: FieldValue.serverTimestamp(),
        success: true
      });

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, lockId, status: 'locked' }) };
    }

    // ── ACTION: add_passcode (temporary password) ──────────────
    if (action === 'add_passcode') {
      const { lockId, passcode, startDate, endDate, name, type = 3 } = body;
      // type: 1=permanent, 2=timed, 3=single-use, 4=periodic
      if (!lockId || !passcode) return { statusCode: 400, headers, body: JSON.stringify({ error: 'lockId and passcode required' }) };

      const params = { lockId, keyboardPwd: passcode, keyboardPwdName: name || 'NEXIA Auto' };

      if (type === 2 || type === 3) {
        params.startDate = startDate ? new Date(startDate).getTime() : Date.now();
        params.endDate = endDate ? new Date(endDate).getTime() : Date.now() + 86400000;
      }
      params.keyboardPwdType = type;

      const data = await ttCall('/keyboardPwd/add', params, tenantCfg);

      const passcodeDoc = {
        lockId,
        passcode,
        name: name || 'NEXIA Auto',
        type,
        startDate: startDate || null,
        endDate: endDate || null,
        keyboardPwdId: data.keyboardPwdId,
        createdAt: FieldValue.serverTimestamp(),
        active: true
      };

      const ref = await db.collection('tenants').doc(tenantId).collection('iot_passcodes').add(passcodeDoc);

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, passcodeId: ref.id, keyboardPwdId: data.keyboardPwdId })
      };
    }

    // ── ACTION: delete_passcode ────────────────────────────────
    if (action === 'delete_passcode') {
      const { lockId, keyboardPwdId, passcodeFirestoreId } = body;
      if (!lockId || !keyboardPwdId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'lockId and keyboardPwdId required' }) };

      await ttCall('/keyboardPwd/delete', { lockId, keyboardPwdId, deleteType: 1 }, tenantCfg);

      // Mark as inactive in Firestore
      if (passcodeFirestoreId) {
        await db.collection('tenants').doc(tenantId).collection('iot_passcodes')
          .doc(passcodeFirestoreId).update({ active: false, deletedAt: FieldValue.serverTimestamp() });
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── ACTION: list_passcodes ─────────────────────────────────
    if (action === 'list_passcodes') {
      const { lockId, pageNo = 1, pageSize = 50 } = body;
      if (!lockId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'lockId required' }) };

      const data = await ttCall('/keyboardPwd/list', { lockId, pageNo, pageSize }, tenantCfg);
      return { statusCode: 200, headers, body: JSON.stringify({ passcodes: data.list || [], total: data.totalNum || 0 }) };
    }

    // ── ACTION: get_records (access log from lock) ─────────────
    if (action === 'get_records') {
      const { lockId, pageNo = 1, pageSize = 50, startDate, endDate } = body;
      if (!lockId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'lockId required' }) };

      const params = { lockId, pageNo, pageSize };
      if (startDate) params.startDate = new Date(startDate).getTime();
      if (endDate) params.endDate = new Date(endDate).getTime();

      const data = await ttCall('/lockRecord/list', params, tenantCfg);

      // Save records to Firestore
      if (data.list?.length) {
        const batch = db.batch();
        data.list.forEach(record => {
          const ref = db.collection('tenants').doc(tenantId)
            .collection('iot_access_log').doc(`${lockId}_${record.recordId}`);
          batch.set(ref, {
            lockId,
            recordId: record.recordId,
            lockDate: record.lockDate,
            serverDate: record.serverDate,
            success: record.success,
            recordType: record.recordType, // 1=app, 2=pwd, 3=card, 8=fingerprint
            keyboardPwd: record.keyboardPwd,
            username: record.username
          }, { merge: true });
        });
        await batch.commit();
      }

      return { statusCode: 200, headers, body: JSON.stringify({ records: data.list || [], total: data.totalNum || 0 }) };
    }

    // ── ACTION: get_battery ────────────────────────────────────
    if (action === 'get_battery') {
      const { lockId } = body;
      if (!lockId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'lockId required' }) };

      const data = await ttCall('/lock/queryOpenState', { lockId }, tenantCfg);
      const batteryData = await ttCall('/lock/listLockInfo', { lockId }, tenantCfg);

      // Alert if battery low
      const battery = batteryData.electricQuantity || 0;
      if (battery < 20) {
        await db.collection('tenants').doc(tenantId).collection('alerts').add({
          type: 'iot_battery_low',
          lockId,
          lockName: batteryData.lockName,
          battery,
          message: `Bateria baixa (${battery}%) na fechadura ${batteryData.lockName}`,
          createdAt: FieldValue.serverTimestamp(),
          read: false
        });
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          lockId,
          battery,
          isOpen: data.state === 1,
          lockName: batteryData.lockName,
          alert: battery < 20 ? `⚠️ Bateria crítica: ${battery}%` : null
        })
      };
    }

    // ── ACTION: provision_for_booking ──────────────────────────
    // Called when a booking is confirmed — creates timed passcode
    if (action === 'provision_for_booking') {
      const { lockId, bookingId, guestName, guestPhone, checkIn, checkOut } = body;
      if (!lockId || !checkIn || !checkOut) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'lockId, checkIn, checkOut required' }) };
      }

      // Generate 6-digit passcode from booking ID
      const passcode = String(Math.abs(hashCode(bookingId || checkIn))).substring(0, 6).padStart(6, '1');

      const params = {
        lockId,
        keyboardPwd: passcode,
        keyboardPwdName: `Reserva ${guestName || bookingId}`,
        keyboardPwdType: 2, // timed
        startDate: new Date(checkIn).getTime(),
        endDate: new Date(checkOut).getTime()
      };

      const data = await ttCall('/keyboardPwd/add', params, tenantCfg);

      // Save to Firestore
      await db.collection('tenants').doc(tenantId).collection('iot_passcodes').add({
        lockId,
        bookingId: bookingId || null,
        guestName: guestName || null,
        guestPhone: guestPhone || null,
        passcode,
        keyboardPwdId: data.keyboardPwdId,
        checkIn,
        checkOut,
        type: 'booking',
        active: true,
        createdAt: FieldValue.serverTimestamp()
      });

      // Send passcode to guest via WhatsApp/SMS
      if (guestPhone) {
        await sendPasscodeToGuest(tenantId, guestPhone, guestName, passcode, checkIn, checkOut);
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          success: true,
          passcode,
          keyboardPwdId: data.keyboardPwdId,
          message: `Senha ${passcode} ativa de ${checkIn} até ${checkOut}`
        })
      };
    }

    // ── ACTION: revoke_booking ─────────────────────────────────
    if (action === 'revoke_booking') {
      const { bookingId, lockId } = body;
      if (!bookingId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'bookingId required' }) };

      const snap = await db.collection('tenants').doc(tenantId)
        .collection('iot_passcodes').where('bookingId', '==', bookingId).get();

      const results = [];
      for (const doc of snap.docs) {
        const pw = doc.data();
        if (pw.keyboardPwdId && pw.lockId) {
          try {
            await ttCall('/keyboardPwd/delete', {
              lockId: pw.lockId,
              keyboardPwdId: pw.keyboardPwdId,
              deleteType: 1
            }, tenantCfg);
          } catch(e) { /* Log but continue */ }
        }
        await doc.ref.update({ active: false, revokedAt: FieldValue.serverTimestamp() });
        results.push({ passcodeId: doc.id, revoked: true });
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, revoked: results.length, results }) };
    }

    // ── ACTION: webhook (TTLock push notifications) ────────────
    if (action === 'webhook' || event.httpMethod === 'GET') {
      const { lockId, serverDate, recordType, keyboardPwd, success: suc } = body;

      if (lockId) {
        await db.collection('iot_events').add({
          lockId,
          serverDate,
          recordType,
          keyboardPwd,
          success: suc,
          receivedAt: FieldValue.serverTimestamp()
        });

        // Alert for unauthorized access attempts
        if (suc === false) {
          await db.collection('tenants').doc(tenantId).collection('alerts').add({
            type: 'iot_unauthorized_access',
            lockId,
            message: `⚠️ Tentativa de acesso não autorizado na fechadura ${lockId}`,
            createdAt: FieldValue.serverTimestamp(),
            read: false
          });
        }
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch(err) {
    console.error('Sentinel IoT error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Utilities ───────────────────────────────────────────────────
function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

async function sendPasscodeToGuest(tenantId, phone, name, passcode, checkIn, checkOut) {
  try {
    const checkInDate = new Date(checkIn).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const checkOutDate = new Date(checkOut).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });

    await fetch(`${process.env.URL || 'https://nexia.app'}/.netlify/functions/whatsapp-business`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'send_message',
        tenantId,
        to: phone,
        message: `🔐 *Sua senha de acesso*\n\nOlá, ${name || 'hóspede'}!\n\nSua reserva está confirmada.\n\n*Senha de acesso:* \`${passcode}\`\n*Check-in:* ${checkInDate}\n*Check-out:* ${checkOutDate}\n\nEsta senha funcionará apenas no período da sua reserva.\n\n_NEXIA Sentinel IoT_`
      })
    });
  } catch(e) {
    console.warn('Failed to send passcode via WhatsApp:', e.message);
  }
}
