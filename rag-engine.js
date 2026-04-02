'use strict';

/**
/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — RAG ENGINE v10.0 (NOVO)                  ║
 * ║  PDF Chunking · TF-IDF · Context Injection           ║
 * ╚══════════════════════════════════════════════════════╝
 */

const { guard, HEADERS, makeHeaders } = require('./middleware');

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

// TF-IDF Simplificado para busca de similaridade sem dependências externas pesadas
function computeSimilarity(query, text) {
  const queryWords = query.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const textWords = text.toLowerCase().split(/\W+/);
  let score = 0;
  for (const word of queryWords) {
    if (textWords.includes(word)) score++;
  }
  return score / queryWords.length;
}

async function buildRAGContext(tenantId, query) {
  try {
    const snapshot = await db.collection("tenants").doc(tenantId).collection("rag_index").get();
    const results = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      for (const chunk of data.chunks) {
        const score = computeSimilarity(query, chunk);
        if (score > 0.2) results.push({ chunk, score, fileName: data.fileName }); // Ajuste o threshold conforme necessário
      }
    });

    const topResults = results.sort((a, b) => b.score - a.score).slice(0, 3); // Pega os 3 melhores
    return topResults.map(r => `[Documento: ${r.fileName}]\n${r.chunk}`).join("\n\n");
  } catch (e) {
    console.error("[RAG-ENGINE] Error building RAG context:", e.message);
    return "";
  }
}

exports.buildRAGContext = buildRAGContext;

exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    const g = await guard(event, 'rag-engine');
  if (g) return g;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }
  const { action, tenantId, userId, fileName, content, query } = body;

  try {
    if (action === 'index') {
      // Chunking simples: divide o texto em blocos de ~800 caracteres com overlap
      const CHUNK_SIZE = 800;
      const OVERLAP = 150;
      const chunks = [];
      for (let i = 0; i < content.length; i += (CHUNK_SIZE - OVERLAP)) {
        chunks.push(content.substring(i, i + CHUNK_SIZE));
      }

      const batch = db.batch();
      const docRef = db.collection('tenants').doc(tenantId).collection('rag_index').doc();
      
      batch.set(docRef, {
        fileName,
        userId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        chunks: chunks.slice(0, 50) // Limita para não estourar o tamanho do doc no Firestore
      });

      await batch.commit();
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, chunksIndexed: chunks.length }) };
    }

    if (action === 'search') {
      const snapshot = await db.collection('tenants').doc(tenantId).collection('rag_index').get();
      const results = [];

      snapshot.forEach(doc => {
        const data = doc.data();
        for (const chunk of data.chunks) {
          const score = computeSimilarity(query, chunk);
          if (score > 0) results.push({ chunk, score, fileName: data.fileName });
        }
      });

      const topResults = results.sort((a, b) => b.score - a.score).slice(0, 5);
      return { statusCode: 200, headers, body: JSON.stringify({ results: topResults }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ação inválida' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
