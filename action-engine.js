/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — ACTION ENGINE v9.0                      ║
 * ║  CRUD completo · Validação · Roles · Rollback real  ║
 * ║  FIX v9: role-check por ação, proteção bulk delete  ║
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
const now = () => admin && admin.firestore
  ? admin.firestore.FieldValue.serverTimestamp()
  : new Date().toISOString();
const { guard, checkPermission, HEADERS, makeHeaders } = require('./middleware');
const { emitEvent }  = require('./event-processor');
const { checkLimit } = require('./tenant-admin');


// ── Schema de ações: collection, campos obrigatórios, editáveis ─
const ACTION_SCHEMA = {
  // CLIENTS
  createClient:  { col: 'clients',  required: ['nome'],          writable: ['nome','email','telefone','empresa','status','origem','notas','orcamento','tags'] },
  updateClient:  { col: 'clients',  required: ['id'],            writable: ['nome','email','telefone','empresa','status','notas','orcamento','tags'] },
  deleteClient:  { col: 'clients',  required: ['id'],            writable: [], minRole: 'admin' },
  // TASKS
  createTask:    { col: 'tasks',    required: ['titulo'],        writable: ['titulo','descricao','responsavel','prioridade','status','dataVencimento','clienteId','tags'] },
  updateTask:    { col: 'tasks',    required: ['id'],            writable: ['titulo','descricao','responsavel','prioridade','status','dataVencimento','tags'] },
  deleteTask:    { col: 'tasks',    required: ['id'],            writable: [], minRole: 'manager' },
  // MEETINGS
  createMeeting: { col: 'meetings', required: ['titulo','dataHora'], writable: ['titulo','descricao','dataHora','participantes','local','status','link','duracao'] },
  updateMeeting: { col: 'meetings', required: ['id'],            writable: ['titulo','descricao','dataHora','participantes','local','status','link','duracao'] },
  deleteMeeting: { col: 'meetings', required: ['id'],            writable: [], minRole: 'manager' },
  // FINANCE
  createFinance: { col: 'finance',  required: ['descricao','valor','tipo'], writable: ['descricao','valor','tipo','categoria','data','status','notas','clienteId','anexo'] },
  updateFinance: { col: 'finance',  required: ['id'],            writable: ['descricao','valor','tipo','categoria','data','status','notas'] },
  deleteFinance: { col: 'finance',  required: ['id'],            writable: [], minRole: 'admin' },
  // NOTES (novo em v9)
  createNote:    { col: 'notes',    required: ['conteudo'],      writable: ['conteudo','titulo','clienteId','taskId','tipo','tags'] },
  updateNote:    { col: 'notes',    required: ['id'],            writable: ['conteudo','titulo','tags'] },
  deleteNote:    { col: 'notes',    required: ['id'],            writable: [], minRole: 'member' }
};


// ── Nível mínimo de role por hierarquia ───────────────────────
const ROLE_HIERARCHY = { master: 5, admin: 4, manager: 3, member: 2, user: 1 };


function hasMinRole(role, minRole) {
  return (ROLE_HIERARCHY[role] || 0) >= (ROLE_HIERARCHY[minRole] || 0);
}


// ── Sanitiza string ────────────────────────────────────────────
function sanitizeStr(val) {
  if (typeof val !== 'string') return val;
  return val
    .replace(/<[^>]*>/g, '')    // remove HTML tags
    .replace(/[{}$]/g, '')      // remove Firestore injection chars
    .replace(/\.\.\//g, '')     // remove path traversal
    .trim()
    .slice(0, 1000);
}


// ── Sanitiza valor de acordo com tipo esperado ────────────────
function sanitizeValue(val) {
  if (typeof val === 'string')  return sanitizeStr(val);
  if (typeof val === 'number')  return isFinite(val) ? val : 0;
  if (typeof val === 'boolean') return val;
  if (Array.isArray(val))       return val.slice(0, 50).map(v => typeof v === 'string' ? sanitizeStr(v) : v);
  return val;
}


// ── Valida e sanitiza payload ──────────────────────────────────
function validatePayload(action, data) {
  const schema = ACTION_SCHEMA[action];
  if (!schema) throw new Error(`Ação desconhecida: "${action}"`);


  for (const field of schema.required) {
    if (field !== 'id' && (data[field] === undefined || data[field] === null || data[field] === '')) {
      throw new Error(`Campo obrigatório ausente: "${field}"`);
    }
  }


  if (action.startsWith('delete')) {
    if (!data.id) throw new Error('id é obrigatório para delete');
    return { id: sanitizeStr(String(data.id)) };
  }


  const clean = {};
  for (const field of schema.writable) {
    if (data[field] !== undefined) {
      clean[field] = sanitizeValue(data[field]);
    }
  }


  if (data.id) clean.id = sanitizeStr(String(data.id));

  // Normaliza telefone: salva sempre só dígitos para buscas consistentes
  if (clean.telefone && typeof clean.telefone === 'string') {
    clean.telefone = clean.telefone.replace(/\D/g, '');
  }

  return clean;
}


// ── Log de auditoria ──────────────────────────────────────────
async function auditLog(tenantId, action, docId, userId, ok, meta = {}) {
  try {
    await db.collection('tenants').doc(tenantId).collection('action_logs').add({ ttl: admin.firestore.Timestamp.fromMillis(Date.now() + 2592000000),
      action, docId, userId, ok, meta,
      ts: now()
    });
  } catch {}
}


// ── CREATE ────────────────────────────────────────────────────
async function execCreate(action, data, tenantId, userId) {
  const schema  = ACTION_SCHEMA[action];
  const clean   = validatePayload(action, data);
  const payload = {
    ...clean,
    tenantId,
    createdBy: userId || 'CORTEX_AI',
    createdAt: now(),
    updatedAt: now(),
    origem:    data.origem || 'ACTION_ENGINE',
    _deleted:  false
  };


  const ref = await db.collection('tenants').doc(tenantId)
    .collection(schema.col).add(payload);


  await auditLog(tenantId, action, ref.id, userId, true);


  // Emite evento para triggers automáticos
  const evType = schema.col.replace(/s$/, '') + ':created';
  emitEvent(evType, { id: ref.id, ...clean }, tenantId).catch(() => {});


  return { ok: true, id: ref.id, action, collection: schema.col };
}


// ── UPDATE ────────────────────────────────────────────────────
async function execUpdate(action, data, tenantId, userId) {
  const schema      = ACTION_SCHEMA[action];
  const clean       = validatePayload(action, data);
  const { id, ...fields } = clean;
  if (!id) throw new Error('id é obrigatório para update');


  const ref  = db.collection('tenants').doc(tenantId).collection(schema.col).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Documento não encontrado: ${id}`);


  // Garante que o doc pertence a este tenant
  const docData = snap.data();
  if (docData.tenantId && docData.tenantId !== tenantId) {
    throw new Error('Acesso negado: documento pertence a outro tenant');
  }


  const before = docData;
  await ref.update({ ...fields, updatedAt: now(), updatedBy: userId || 'CORTEX_AI' });
  await auditLog(tenantId, action, id, userId, true, { before, after: fields });


  return { ok: true, id, action, collection: schema.col };
}


// ── DELETE (soft delete) ──────────────────────────────────────
async function execDelete(action, data, tenantId, userId, role = 'user') {
  const schema   = ACTION_SCHEMA[action];
  const minRole  = schema.minRole || 'admin';


  // FIX v9: verifica role mínimo para delete
  if (!hasMinRole(role, minRole)) {
    throw new Error(`Role "${role}" não tem permissão para deletar. Mínimo: ${minRole}`);
  }


  const { id } = validatePayload(action, data);
  if (!id) throw new Error('id é obrigatório para delete');


  const ref  = db.collection('tenants').doc(tenantId).collection(schema.col).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Documento não encontrado: ${id}`);


  const docData = snap.data();
  if (docData.tenantId && docData.tenantId !== tenantId) {
    throw new Error('Acesso negado: documento pertence a outro tenant');
  }


  // Soft delete: mantém dado, apenas marca como deletado
  await ref.update({
    _deleted:    true,
    deletedAt:   now(),
    deletedBy:   userId || 'CORTEX_AI',
    _snapBefore: JSON.stringify(docData).slice(0, 5000) // snapshot para rollback
  });


  await auditLog(tenantId, action, id, userId, true, { role });
  return { ok: true, id, action, collection: schema.col };
}


// ── ROLLBACK de soft delete ────────────────────────────────────
async function execRollback(docId, collection, tenantId, userId) {
  const ref  = db.collection('tenants').doc(tenantId).collection(collection).doc(docId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Documento não encontrado');


  const data = snap.data();
  if (!data._deleted) throw new Error('Documento não está deletado');


  const snapBefore = data._snapBefore ? JSON.parse(data._snapBefore) : null;
  const restore    = snapBefore || { ...data };
  delete restore._deleted;
  delete restore.deletedAt;
  delete restore.deletedBy;
  delete restore._snapBefore;


  await ref.set({ ...restore, updatedAt: now(), restoredBy: userId });
  await auditLog(tenantId, 'rollback', docId, userId, true, { collection });
  return { ok: true, restored: docId };
}


// ── Roteador principal ────────────────────────────────────────
async function dispatch(action, data, tenantId, userId, role = 'user') {
  if (!ACTION_SCHEMA[action]) throw new Error(`Ação desconhecida: "${action}"`);
  if (action.startsWith('create')) return execCreate(action, data, tenantId, userId);
  if (action.startsWith('update')) return execUpdate(action, data, tenantId, userId);
  if (action.startsWith('delete')) return execDelete(action, data, tenantId, userId, role);
  throw new Error(`Tipo de ação não reconhecido: "${action}"`);
}


// ── Handler Netlify ───────────────────────────────────────────
exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };


  const guardErr = await guard(event, 'action-engine');
  if (guardErr) return guardErr;


  try {
    const { action, data = {}, tenantId, userId } = JSON.parse(event.body || '{}');


    if (!action)   throw new Error('action é obrigatório');
    if (!tenantId) throw new Error('tenantId é obrigatório');
    if (!ACTION_SCHEMA[action]) throw new Error(
      `Ação inválida: "${action}". Disponíveis: ${Object.keys(ACTION_SCHEMA).join(', ')}`
    );


    const role = event._role || 'user';


    // Verifica permissão de role
    if (!checkPermission(role, action)) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ ok: false, error: `Role "${role}" não tem permissão para "${action}"` })
      };
    }


    // Verifica limite do plano antes de creates
    if (action.startsWith('create')) {
      const resource = ACTION_SCHEMA[action]?.col?.replace(/s$/, '');
      if (resource) {
        const limit = await checkLimit(tenantId, resource + 's');
        if (!limit.ok) {
          return {
            statusCode: 402,
            headers,
            body: JSON.stringify({ ok: false, error: limit.message, upgrade: true })
          };
        }
      }
    }


    // Rollback especial
    if (action === 'rollback') {
      const { docId, collection } = data;
      if (!docId || !collection) throw new Error('docId e collection são obrigatórios para rollback');
      const result = await execRollback(docId, collection, tenantId, userId);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }


    const result = await dispatch(action, data, tenantId, userId, role);
    if (process.env.NODE_ENV !== 'production') console.error(`[ACTION-ENGINE] ✅ ${action} | tenant:${tenantId} | id:${result.id}`);
    return { statusCode: 200, headers, body: JSON.stringify(result) };


  } catch (err) {
    console.error('[ACTION-ENGINE] ❌', err.message);
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};


exports.dispatch     = dispatch;
exports.ACTION_SCHEMA = ACTION_SCHEMA;












