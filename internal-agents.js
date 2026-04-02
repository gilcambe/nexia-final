'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS — INTERNAL AGENTS v1.0                            ║
 * ║  QA Agent · Debug Agent · Perf Agent · Security Agent      ║
 * ║  Alternativa gratuita ao CI/CD pago: roda via Netlify       ║
 * ║  Scheduled: metrics-aggregator dispara a cada hora          ║
 * ╚══════════════════════════════════════════════════════════════╝
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
} catch (e) { console.warn('[AGENTS] Firebase indisponivel:', e.message); db = null; }

const { guard, HEADERS, makeHeaders } = require('./middleware');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  const auth = await guard(event, 'internal-agents'); // VULN-01 fix: await obrigatório
  if (auth) return auth; // guard retorna resposta de erro ou null se ok

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

  const { agent, action, payload } = body;
  const params = event.queryStringParameters || {};

  const agentId = agent || params.agent || 'qa';

  try {
    let result;
    switch (agentId) {
      case 'qa':       result = await qaAgent(action, payload); break;
      case 'debug':    result = await debugAgent(action, payload); break;
      case 'perf':     result = await perfAgent(action, payload); break;
      case 'security': result = await securityAgent(action, payload); break;
      case 'refactor': result = await refactorAgent(action, payload); break;
      case 'all':      result = await runAllAgents(); break;
      default: return { statusCode: 400, headers, body: JSON.stringify({ error: 'agent inválido. Use: qa|debug|perf|security|refactor|all' }) };
    }

    // Salva resultado no Firestore
    if (db) {
      await db.collection('agent_runs').add({
        agent: agentId, action, result,
        ts: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ agent: agentId, result }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

// ── QA AGENT ─────────────────────────────────────────────────────
async function qaAgent(action, payload) {
  const baseUrl = process.env.NEXIA_APP_URL || 'https://nexiaos.netlify.app';
  const tests = [];
  const start = Date.now();

  // Testa endpoints críticos
  const endpoints = [
    { name: 'cortex ping', method: 'POST', path: '/api/cortex', body: { userId: 'qa-agent', tenantId: 'nexia', message: 'ping', stream: false } },
    { name: 'auth health', method: 'POST', path: '/api/auth', body: { action: 'health' } },
    { name: 'kpi summary', method: 'GET', path: '/api/kpi?action=summary' },
    { name: 'metrics', method: 'GET', path: '/api/metrics' },
  ];

  for (const ep of endpoints) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: { 'Content-Type': 'application/json', 'x-qa-agent': 'true' },
        body: ep.body ? JSON.stringify(ep.body) : undefined,
        signal: AbortSignal.timeout(10000)
      });
      const latency = Date.now() - t0;
      tests.push({ name: ep.name, status: res.status, ok: res.status < 500, latency });
    } catch (e) {
      tests.push({ name: ep.name, status: 0, ok: false, latency: Date.now() - t0, error: e.message });
    }
  }

  const passed = tests.filter(t => t.ok).length;
  const failed = tests.filter(t => !t.ok).length;
  const avgLatency = Math.round(tests.reduce((sum, t) => sum + t.latency, 0) / tests.length);
  const health = failed === 0 ? 'HEALTHY' : failed <= 1 ? 'DEGRADED' : 'DOWN';

  // Salva resultado de health no Firestore
  if (db) {
    await db.collection('qa_reports').add({
      health, passed, failed, avgLatency, tests,
      totalMs: Date.now() - start,
      ts: admin.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});
  }

  return { health, passed, failed, avgLatency, tests, totalMs: Date.now() - start };
}

// ── DEBUG AGENT ───────────────────────────────────────────────────
async function debugAgent(action, payload) {
  if (!db) return { error: 'Firebase obrigatório para debug agent' };

  // Lê erros dos últimos 24h
  const since = new Date(Date.now() - 86400000);
  const errors = [];

  try {
    const snap = await db.collection('error_logs')
      .where('ts', '>=', admin.firestore.Timestamp.fromDate(since))
      .orderBy('ts', 'desc').limit(50).get();

    snap.forEach(d => errors.push({ id: d.id, ...d.data() }));
  } catch {}

  // Agrupa por tipo
  const grouped = {};
  for (const err of errors) {
    const key = err.type || err.message?.slice(0, 50) || 'unknown';
    if (!grouped[key]) grouped[key] = { count: 0, first: err.ts, last: err.ts, examples: [] };
    grouped[key].count++;
    if (grouped[key].examples.length < 3) grouped[key].examples.push(err.context || '');
  }

  // Se há erros recorrentes, pede sugestão de fix à IA
  const topErrors = Object.entries(grouped)
    .sort((a, b) => b[1].count - a[1].count).slice(0, 5)
    .map(([type, data]) => ({ type, ...data }));

  let aiSuggestions = [];
  if (topErrors.length > 0 && process.env.GROQ_API_KEY) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `Erros recorrentes no sistema NEXIA OS (Node.js + Firebase + Netlify Functions):
${JSON.stringify(topErrors, null, 2)}

Para cada erro, sugira a causa mais provável e a correção em 1-2 linhas. JSON: {"suggestions": [{"error": "...", "cause": "...", "fix": "..."}]}`
          }]
        })
      });
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '{}';
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      aiSuggestions = parsed.suggestions || [];
    } catch {}
  }

  return {
    totalErrors: errors.length,
    topErrors,
    aiSuggestions,
    period: '24h',
    analyzedAt: new Date().toISOString()
  };
}

// ── PERF AGENT ────────────────────────────────────────────────────
async function perfAgent(action, payload) {
  if (!db) return { error: 'Firebase obrigatório para perf agent' };

  // Lê métricas de latência do Firestore
  const since = new Date(Date.now() - 3600000); // última hora
  const metrics = { endpointStats: {}, slowRequests: [], recommendations: [] };

  try {
    const snap = await db.collection('request_logs')
      .where('ts', '>=', admin.firestore.Timestamp.fromDate(since))
      .orderBy('ts', 'desc').limit(200).get();

    snap.forEach(d => {
      const data = d.data();
      const ep = data.endpoint || 'unknown';
      if (!metrics.endpointStats[ep]) metrics.endpointStats[ep] = { count: 0, totalMs: 0, errors: 0, p95: [] };
      metrics.endpointStats[ep].count++;
      metrics.endpointStats[ep].totalMs += data.latency || 0;
      metrics.endpointStats[ep].p95.push(data.latency || 0);
      if (data.status >= 500) metrics.endpointStats[ep].errors++;
      if (data.latency > 3000) metrics.slowRequests.push({ endpoint: ep, latency: data.latency, ts: data.ts });
    });
  } catch {}

  // Calcula p95 e médias
  const summary = Object.entries(metrics.endpointStats).map(([ep, s]) => {
    const avg = s.count > 0 ? Math.round(s.totalMs / s.count) : 0;
    const sorted = s.p95.sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const errorRate = s.count > 0 ? parseFloat(((s.errors / s.count) * 100).toFixed(1)) : 0;
    return { endpoint: ep, requests: s.count, avgMs: avg, p95Ms: p95, errorRate };
  }).sort((a, b) => b.p95Ms - a.p95Ms);

  // Recomendações automáticas
  for (const ep of summary) {
    if (ep.p95Ms > 5000) metrics.recommendations.push(`${ep.endpoint}: p95 ${ep.p95Ms}ms — considere cache ou timeout menor`);
    if (ep.errorRate > 5) metrics.recommendations.push(`${ep.endpoint}: taxa de erro ${ep.errorRate}% — investigar logs`);
  }

  return {
    period: '1h',
    endpoints: summary,
    slowRequests: metrics.slowRequests.slice(0, 10),
    recommendations: metrics.recommendations,
    analyzedAt: new Date().toISOString()
  };
}

// ── SECURITY AGENT ────────────────────────────────────────────────
async function securityAgent(action, payload) {
  if (!db) return { error: 'Firebase obrigatório para security agent' };

  const alerts = [];
  const since = new Date(Date.now() - 3600000);

  try {
    // Rate limit hits
    const rateLimitSnap = await db.collection('rate_limits')
      .where('blocked', '==', true)
      .where('ts', '>=', admin.firestore.Timestamp.fromDate(since))
      .get();

    if (rateLimitSnap.size > 10) {
      alerts.push({ level: 'HIGH', type: 'RATE_LIMIT_SURGE', detail: `${rateLimitSnap.size} bloqueios em 1h` });
    }

    // Auth failures
    const authFailSnap = await db.collection('auth_failures')
      .where('ts', '>=', admin.firestore.Timestamp.fromDate(since))
      .get();

    // Agrupa por IP
    const failsByIp = {};
    authFailSnap.forEach(d => {
      const ip = d.data().ip || 'unknown';
      failsByIp[ip] = (failsByIp[ip] || 0) + 1;
    });
    const suspiciousIps = Object.entries(failsByIp).filter(([, count]) => count > 5);
    if (suspiciousIps.length > 0) {
      alerts.push({ level: 'MEDIUM', type: 'BRUTE_FORCE_ATTEMPT', detail: `IPs suspeitos: ${suspiciousIps.map(([ip, c]) => `${ip}(${c}x)`).join(', ')}` });
    }

    // Prompt injection attempts
    const injectionSnap = await db.collection('security_events')
      .where('type', '==', 'prompt_injection')
      .where('ts', '>=', admin.firestore.Timestamp.fromDate(since))
      .get();

    if (injectionSnap.size > 0) {
      alerts.push({ level: 'HIGH', type: 'PROMPT_INJECTION_ATTEMPTS', detail: `${injectionSnap.size} tentativas detectadas` });
    }
  } catch {}

  const status = alerts.some(a => a.level === 'HIGH') ? 'CRITICAL' :
                 alerts.some(a => a.level === 'MEDIUM') ? 'WARNING' : 'SECURE';

  return { status, alerts, period: '1h', scannedAt: new Date().toISOString() };
}

// ── REFACTOR AGENT ────────────────────────────────────────────────
async function refactorAgent(action, payload) {
  // Analisa código submetido via payload.code e sugere melhorias
  const { code, language = 'javascript', context = '' } = payload || {};
  if (!code) return { error: 'payload.code obrigatório' };

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return { error: 'GROQ_API_KEY necessária para refactor agent' };

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1500,
      messages: [{
        role: 'system',
        content: 'Você é um engenheiro sênior especialista em código limpo, performance e segurança. Responda em português.'
      }, {
        role: 'user',
        content: `Analise este código ${language} e sugira melhorias:

${context ? `Contexto: ${context}\n\n` : ''}
\`\`\`${language}
${code.slice(0, 3000)}
\`\`\`

Responda em JSON: {"issues": [{"type": "bug|perf|security|style", "line": "...", "description": "...", "fix": "..."}], "refactored": "código melhorado", "summary": "resumo das mudanças"}`
      }]
    })
  });

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return { raw: text };
  }
}

// ── RUN ALL ───────────────────────────────────────────────────────
async function runAllAgents() {
  const results = {};
  try { results.qa = await qaAgent(); } catch (e) { results.qa = { error: e.message }; }
  try { results.debug = await debugAgent(); } catch (e) { results.debug = { error: e.message }; }
  try { results.perf = await perfAgent(); } catch (e) { results.perf = { error: e.message }; }
  try { results.security = await securityAgent(); } catch (e) { results.security = { error: e.message }; }

  const overallHealth = (results.qa?.health === 'HEALTHY' && results.security?.status === 'SECURE') ? 'HEALTHY' : 'CHECK_NEEDED';

  if (db) {
    await db.collection('system_health').add({
      health: overallHealth, results,
      ts: admin.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});
  }

  return { overallHealth, results, ranAt: new Date().toISOString() };
}
