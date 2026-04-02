/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — CORTEX LEARN v9.0                       ║
 * ║  Auto-aprendizado com similaridade melhorada        ║
 * ║  N-gram + intent weighting + TTL de exemplos        ║
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
const { guard, makeHeaders} = require('./middleware');


const MAX_EXAMPLES    = 300;  // aumentado de 200
const TOP_K           = 5;
const MIN_RATING      = 3;    // inclui neutros (era 4)
const EXAMPLE_TTL_DAYS = 90;  // remove exemplos não usados há 90 dias


// ── Similaridade melhorada: Jaccard de bigramas ───────────────
function tokenize(text) {
  return text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos para comparar
    .split(/\W+/)
    .filter(w => w.length > 2);
}


function bigrams(tokens) {
  const bg = new Set();
  for (let i = 0; i < tokens.length - 1; i++) {
    bg.add(tokens[i] + '_' + tokens[i + 1]);
  }
  return bg;
}


function similarity(a, b) {
  const tokA = tokenize(a);
  const tokB = tokenize(b);


  // Similaridade de unigramas
  const setA = new Set(tokA);
  const setB = new Set(tokB);
  let uniCommon = 0;
  setA.forEach(w => { if (setB.has(w)) uniCommon++; });
  const uniSim = uniCommon / Math.max(setA.size, setB.size, 1);


  // Similaridade de bigramas (contexto de 2 palavras)
  const bgA = bigrams(tokA);
  const bgB = bigrams(tokB);
  let bgCommon = 0;
  bgA.forEach(w => { if (bgB.has(w)) bgCommon++; });
  const bgSim = bgCommon / Math.max(bgA.size, bgB.size, 1);


  // Peso maior para bigramas (mais específicos)
  return (uniSim * 0.4) + (bgSim * 0.6);
}


// ── Salva boa resposta ─────────────────────────────────────────
async function saveExample(tenantId, userId, prompt, response, intent, conversationId = 'default') {
  if (!tenantId) throw new Error('tenantId obrigatório');


  const col = db.collection('cortex_good_responses')
    .doc(tenantId).collection('examples');


  const promptKey = prompt.slice(0, 200).toLowerCase().trim();


  // Evita duplicatas exatas
  const existing = await col
    .where('promptKey', '==', promptKey)
    .limit(1).get();


  if (!existing.empty) {
    await existing.docs[0].ref.update({
      conversationId,
      usedCount: admin.firestore.FieldValue.increment(1),
      lastUsed:  now(),
      updatedAt: now()
    });
    return { id: existing.docs[0].id, duplicate: true };
  }


  // Remove exemplos velhos se chegou no teto
  const countSnap = await col.count().get().catch(() => null);
  const count     = countSnap?.data().count ?? 0;


  if (count >= MAX_EXAMPLES) {
    // Remove o pior: menor rating + mais antigo
    const oldest = await col
      .orderBy('rating', 'asc')
      .orderBy('lastUsed', 'asc')
      .limit(3).get();
    if (!oldest.empty) {
      const batch = db.batch();
      oldest.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  }


  const ref = await col.add({
      conversationId,
    prompt:    prompt.slice(0, 500),
    promptKey,
    response:  response.slice(0, 3000),
    intent:    intent || 'chat',
    rating:    3,
    usedCount: 0,
    userId,
    tenantId,
    lastUsed:  now(),
    createdAt: now(),
    updatedAt: now()
  });


  return { id: ref.id, saved: true };
}


// ── Avalia exemplo ─────────────────────────────────────────────
async function rateExample(tenantId, exampleId, rating) {
  const r = Math.max(1, Math.min(5, Number(rating)));
  const ref = db.collection('cortex_good_responses')
    .doc(tenantId).collection('examples').doc(exampleId);


  const snap = await ref.get();
  if (!snap.exists) throw new Error('Exemplo não encontrado');
  if (snap.data().tenantId !== tenantId) throw new Error('Acesso negado');


  await ref.update({ rating: r, updatedAt: now() });
  return { id: exampleId, rating: r };
}


// ── Busca exemplos similares ──────────────────────────────────
async function findSimilar(tenantId, query, topK = TOP_K) {
  if (!tenantId || !query) return [];


  const snap = await db.collection('cortex_good_responses')
    .doc(tenantId).collection('examples')
    .where('rating', '>=', MIN_RATING)
    .orderBy('rating', 'desc')
    .orderBy('usedCount', 'desc')
    .limit(80)
    .get();


  if (snap.empty) return [];


  const scored = snap.docs.map(d => ({
    id: d.id,
    ...d.data(),
    score: similarity(query, d.data().prompt)
  }));


  return scored
    .filter(e => e.score > 0.08)
    .sort((a, b) => {
      // Ordena por: score (70%) + rating bonus (30%)
      const scoreA = a.score * 0.7 + (a.rating / 5) * 0.3;
      const scoreB = b.score * 0.7 + (b.rating / 5) * 0.3;
      return scoreB - scoreA;
    })
    .slice(0, topK)
    .map(e => ({ prompt: e.prompt, response: e.response, intent: e.intent, score: e.score }));
}


// ── Monta contexto de aprendizado para injetar na IA ─────────
async function buildLearningContext(tenantId, query) {
  const examples = await findSimilar(tenantId, query);
  if (!examples.length) return null;


  const text = examples
    .slice(0, 3) // máximo 3 exemplos para não poluir o contexto
    .map((e, i) =>
      `[${e.intent.toUpperCase()}] Usuário: "${e.prompt.slice(0, 200)}"\nResposta aprovada: "${e.response.slice(0, 400)}"`
    ).join('\n\n');


  return {
    role:    'system',
    content: `REFERÊNCIAS DE QUALIDADE (respostas anteriores bem avaliadas para este tenant):\n\n${text}\n\nUse como referência de tom e formato, mas adapte à situação atual.`
  };
}


// ── Remove exemplos expirados (TTL) ───────────────────────────
async function pruneOldExamples(tenantId) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - EXAMPLE_TTL_DAYS);


  const snap = await db.collection('cortex_good_responses')
    .doc(tenantId).collection('examples')
    .where('rating', '<=', 2)
    .where('lastUsed', '<', admin.firestore.Timestamp.fromDate(cutoff))
    .limit(20)
    .get();


  if (snap.empty) return { pruned: 0 };


  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  return { pruned: snap.size };
}


// ── Handler Netlify ────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = makeHeaders(event);
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };


  const guardErr = await guard(event, 'cortex-learn', { skipTenant: true });
  if (guardErr) return guardErr;


  try {
    if (event.httpMethod === 'GET') {
      const p      = event.queryStringParameters || {};
      const tenant = p.tenantId;
      const query  = p.query || '';
      if (!tenant) throw new Error('tenantId é obrigatório');


      if (p.action === 'prune') {
        const result = await pruneOldExamples(tenant);
        return { statusCode: 200, headers, body: JSON.stringify(result) };
      }


      const results = await findSimilar(tenant, query);
      return { statusCode: 200, headers, body: JSON.stringify({ results }) };
    }


    const { action, tenantId, userId, prompt, response, intent, exampleId, rating, conversationId = 'default' } = JSON.parse(event.body || "{}");
    if (!tenantId) throw new Error('tenantId é obrigatório');


    if (action === 'save') {
      if (!prompt || !response) throw new Error('prompt e response são obrigatórios');
      const result = await saveExample(tenantId, userId, prompt, response, intent, conversationId);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };
    }


    if (action === 'rate') {
      if (!exampleId || rating === undefined) throw new Error('exampleId e rating são obrigatórios');
      const result = await rateExample(tenantId, exampleId, rating);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };
    }


    if (action === 'list') {
      const snap = await db.collection('cortex_good_responses')
        .doc(tenantId).collection('examples')
        .orderBy('rating', 'desc')
        .orderBy('usedCount', 'desc')
        .limit(100).get();
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return { statusCode: 200, headers, body: JSON.stringify({ examples: list, total: list.length }) };
    }


    throw new Error(`Ação desconhecida: ${action}`);
  } catch (err) {
    console.error('[CORTEX-LEARN] ❌', err.message);
    return { statusCode: 400, headers, body: JSON.stringify({ error: err.message }) };
  }
};


exports.saveExample          = saveExample;
exports.findSimilar          = findSimilar;
exports.buildLearningContext = buildLearningContext;
exports.rateExample          = rateExample;
exports.pruneOldExamples     = pruneOldExamples;
