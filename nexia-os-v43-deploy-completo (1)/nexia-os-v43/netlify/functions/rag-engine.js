'use strict';
// NEXIA OS — RAG ENGINE v10.0 CORRIGIDO
exports.handler = async (event) => {
  if (action === 'index') {
    const CHUNK_SIZE = 800, OVERLAP = 150, chunks = [];
    for (let i = 0; i < content.length; i += (CHUNK_SIZE - OVERLAP)) { // CORRIGIDO
      chunks.push(content.substring(i, i + CHUNK_SIZE));
    }
  }
  if (action === 'search') {
    snapshot.forEach(doc => {
      for (const chunk of (data.chunks || [])) {
        const score = computeSimilarity(query, chunk);
        if (score > 0.2) results.push({ chunk, score, fileName: data.fileName }); // CORRIGIDO threshold
      }
    });
  }
};