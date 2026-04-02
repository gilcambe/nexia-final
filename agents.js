/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — AGENTS API v9.0                         ║
 * ║  CRUD com isolamento de tenant                      ║
 * ║  FIX v9: todos os agentes filtrados por tenantId    ║
 * ║  Agentes globais usam flag { global: true }         ║
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
const now = () => admin.firestore.FieldValue.serverTimestamp();
const { guard, HEADERS, makeHeaders, checkPermission } = require('./middleware');


// Agentes built-in que ninguém pode deletar
const PROTECTED_GLOBAL = ['business', 'dev', 'security'];


exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };


  const guardErr = await guard(event, 'agents');
  if (guardErr) return guardErr;


  try {
    const method  = event.httpMethod;
    const params  = event.queryStringParameters || {};
    const body    = method !== 'GET' ? JSON.parse(event.body || '{}') : {};


    // Extrai tenantId de onde estiver
    const tenantId = params.tenantId || body.tenantId;
    const role     = event._role || 'user';


    if (!tenantId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'tenantId é obrigatório' }) };
    }


    // GET — lista agentes do tenant + globais
    if (method === 'GET' && !params.id) {
      const [tenantSnap, globalSnap] = await Promise.all([
        db.collection('agents').where('tenantId', '==', tenantId).get(),
        db.collection('agents').where('global', '==', true).get()
      ]);


      const seen = new Set();
      const list = [];
      for (const d of [...tenantSnap.docs, ...globalSnap.docs]) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        list.push({ id: d.id, ...d.data() });
      }


      return { statusCode: 200, headers, body: JSON.stringify({ agents: list, total: list.length }) };
    }


    // GET ?id=xxx — busca um agente específico
    if (method === 'GET' && params.id) {
      const doc = await db.collection('agents').doc(params.id).get();
      if (!doc.exists) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Agente não encontrado' }) };
      }
      const agentData = doc.data();
      // Verifica se pertence ao tenant ou é global
      if (!agentData.global && agentData.tenantId !== tenantId) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Acesso negado' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ id: doc.id, ...agentData }) };
    }


    // POST — cria agente
    if (method === 'POST') {
      if (!checkPermission(role, 'createAgent')) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Sem permissão para criar agentes' }) };
      }


      const { name, displayName, description, systemPrompt, agentType, model, temperature, icon, capabilities, tags } = body;
      if (!name || !systemPrompt) throw new Error('name e systemPrompt são obrigatórios');
      if (systemPrompt.length < 20) throw new Error('systemPrompt muito curto (mínimo 20 chars)');
      if (systemPrompt.length > 5000) throw new Error('systemPrompt muito longo (máximo 5000 chars)');


      const id   = 'agent_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
      const data = {
        id,
        name:         name.slice(0, 80),
        displayName:  (displayName || name).slice(0, 80),
        description:  (description || '').slice(0, 500),
        systemPrompt: systemPrompt.slice(0, 5000),
        agentType:    agentType    || 'custom',
        model:        model        || 'llama3-70b-8192',
        temperature:  Math.min(2, Math.max(0, temperature ?? 0.7)),
        icon:         (icon || '🤖').slice(0, 10),
        capabilities: (capabilities || []).slice(0, 20),
        tags:         (tags || []).slice(0, 10),
        tenantId,
        global:       false,  // criados pelo usuário nunca são globais
        active:       true,
        runCount:     0,
        lastRun:      null,
        createdBy:    event._userId || 'unknown',
        createdAt:    now(),
        updatedAt:    now()
      };


      await db.collection('agents').doc(id).set(data);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id, agent: data }) };
    }


    // PATCH — atualiza agente
    if (method === 'PATCH') {
      if (!checkPermission(role, 'updateAgent')) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Sem permissão para editar agentes' }) };
      }


      const { id, ...fields } = body;
      if (!id) throw new Error('id é obrigatório');


      const doc = await db.collection('agents').doc(id).get();
      if (!doc.exists) throw new Error('Agente não encontrado');


      const agentData = doc.data();
      if (!agentData.global && agentData.tenantId !== tenantId) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Acesso negado' }) };
      }
      if (PROTECTED_GLOBAL.includes(id) && fields.systemPrompt !== undefined) {
        throw new Error('System prompt de agentes padrão não pode ser alterado');
      }


      const EDITABLE = ['displayName','description','systemPrompt','agentType','model','temperature','icon','capabilities','tags','active'];
      const update   = {};
      for (const k of EDITABLE) {
        if (fields[k] !== undefined) update[k] = fields[k];
      }
      if (update.systemPrompt) update.systemPrompt = update.systemPrompt.slice(0, 5000);
      update.updatedAt  = now();
      update.updatedBy  = event._userId || 'unknown';


      await db.collection('agents').doc(id).update(update);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id, updated: update }) };
    }


    // DELETE — remove agente
    if (method === 'DELETE') {
      if (!checkPermission(role, 'deleteAgent')) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Sem permissão para deletar agentes' }) };
      }


      const id = params.id || body.id;
      if (!id) throw new Error('id é obrigatório');
      if (PROTECTED_GLOBAL.includes(id)) throw new Error('Agentes padrão não podem ser removidos');


      const doc = await db.collection('agents').doc(id).get();
      if (!doc.exists) throw new Error('Agente não encontrado');
      if (doc.data().tenantId !== tenantId) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Acesso negado' }) };
      }


      await db.collection('agents').doc(id).delete();
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, deleted: id }) };
    }


    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };


  } catch (err) {
    console.error('[AGENTS] ❌', err.message);
    return { statusCode: 400, headers, body: JSON.stringify({ error: err.message }) };
  }
};






