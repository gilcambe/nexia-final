/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — SWARM v9.0                              ║
 * ║  Paralelo · Timeout · Retry · Circuit Breaker       ║
 * ║  FIX v9: agentes filtrados por tenant + circuit     ║
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
const { guard, sanitizePrompt, HEADERS, makeHeaders } = require('./middleware');


const AGENT_TIMEOUT_MS = 15000;
const MAX_RETRIES      = 2;
const MAX_AGENTS       = 5; // limite de agentes por swarm


// ── Circuit Breaker em memória ────────────────────────────────
const _circuitBreaker = new Map();
// { failCount, openedAt }
function isCircuitOpen(agentKey) {
  const cb = _circuitBreaker.get(agentKey);
  if (!cb) return false;
  if (cb.failCount < 3) return false;
  // Auto-reset após 60s
  if (Date.now() - cb.openedAt > 60_000) {
    _circuitBreaker.delete(agentKey);
    return false;
  }
  return true;
}
function recordFailure(agentKey) {
  const cb = _circuitBreaker.get(agentKey) || { failCount: 0, openedAt: 0 };
  cb.failCount += 1;
  cb.openedAt   = Date.now();
  _circuitBreaker.set(agentKey, cb);
}
function recordSuccess(agentKey) {
  _circuitBreaker.delete(agentKey);
}


// ── Agentes built-in ──────────────────────────────────────────
const BUILT_IN_AGENTS = {
  business: { name: 'BUSINESS_AGENT', temperature: 0.7, system: 'Você é um estrategista de negócios sênior. Analise com foco em ROI, mercado e crescimento. Português brasileiro, seja executivo e objetivo.' },
  dev:      { name: 'DEV_AGENT',      temperature: 0.3, system: 'Você é um Principal Engineer. Arquitetura, código limpo, performance, segurança. Português, seja técnico e preciso.' },
  security: { name: 'SECURITY_AGENT', temperature: 0.2, system: 'Você é um CISO virtual. Segurança, vulnerabilidades, compliance, riscos legais. Português, seja criterioso e nunca minimize riscos.' }
};


// ── Carrega agentes do Firestore — filtrado por tenant ─────────
async function loadAgents(tenantId) {
  try {
    const [tenantSnap, globalSnap] = await Promise.all([
      db.collection('agents').where('tenantId', '==', tenantId).where('active', '!=', false).get(),
      db.collection('agents').where('global', '==', true).get()
    ]);


    const dynamic = {};
    const seen = new Set();
    for (const d of [...tenantSnap.docs, ...globalSnap.docs]) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const a = d.data();
      dynamic[d.id] = {
        name:        a.displayName || a.name || d.id,
        temperature: a.temperature ?? 0.7,
        system:      a.systemPrompt || `Você é o agente ${a.displayName || d.id}. Responda em português.`
      };
    }
    return { ...BUILT_IN_AGENTS, ...dynamic };
  } catch {
    return BUILT_IN_AGENTS;
  }
}


// ── Planeja quais agentes usar via IA ─────────────────────────
async function planAgents(task, availableAgents) {
  try {
    const agentList = Object.keys(availableAgents).slice(0, 15).join(', ');
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        temperature: 0,
        max_tokens: 80,
        messages: [
          {
            role: 'system',
            content: `Selecione os agentes mais adequados para a tarefa. Responda SOMENTE JSON: {"agents":["business"],"mode":"parallel"}\nAgentes disponíveis: ${agentList}\nModos: parallel (análises independentes) ou sequential (um alimenta o próximo).`
          },
          { role: 'user', content: task.slice(0, 500) }
        ]
      })
    });
    if (!res.ok) return { agents: ['business'], mode: 'parallel' };
    const data = await res.json();
    const raw  = data.choices[0].message.content.trim();
    const m    = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      // Limita a MAX_AGENTS
      if (parsed.agents) parsed.agents = parsed.agents.slice(0, MAX_AGENTS);
      return parsed;
    }
  } catch {}
  return { agents: ['business'], mode: 'parallel' };
}


// ── Executa um agente com timeout + retry + circuit breaker ───
async function runAgent(agentKey, agent, messages, attempt = 1) {
  // Verifica circuit breaker
  if (isCircuitOpen(agentKey)) {
    return { agentKey, agentName: agent.name, reply: '', actionJson: null, ok: false, error: 'Circuit breaker aberto (agente com falhas repetidas)' };
  }


  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);


  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:       'llama3-70b-8192',
        temperature: agent.temperature ?? 0.5,
        max_tokens:  1500,
        messages:    [{ role: 'system', content: agent.system }, ...messages]
      })
    });
    clearTimeout(timer);


    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data  = await res.json();
    const reply = data.choices[0].message.content;


    // Extrai action JSON se presente
    const actionMatch = reply.match(/```json\s*([\s\S]*?)\s*```/i);
    let actionJson = null;
    if (actionMatch) { try { actionJson = JSON.parse(actionMatch[1]); } catch {} }


    recordSuccess(agentKey);
    return { agentKey, agentName: agent.name, reply, actionJson, ok: true };


  } catch (e) {
    clearTimeout(timer);
    recordFailure(agentKey);


    if (attempt < MAX_RETRIES) {
      console.warn(`[SWARM] Retry ${attempt}/${MAX_RETRIES} para ${agentKey}`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return runAgent(agentKey, agent, messages, attempt + 1);
    }


    return { agentKey, agentName: agent.name, reply: '', actionJson: null, ok: false, error: e.message };
  }
}


// ── Execução paralela ─────────────────────────────────────────
async function runParallel(agentKeys, agents, messages) {
  return Promise.all(
    agentKeys.filter(k => agents[k]).map(k => runAgent(k, agents[k], messages))
  );
}


// ── Execução sequencial ───────────────────────────────────────
async function runSequential(agentKeys, agents, messages) {
  const results = [];
  let ctx = [...messages];


  for (const k of agentKeys) {
    if (!agents[k]) continue;
    const result = await runAgent(k, agents[k], ctx);
    results.push(result);
    if (result.ok) {
      ctx.push({ role: 'assistant', content: `[${agents[k].name}]: ${result.reply.slice(0, 600)}` });
    }
  }
  return results;
}


// ── Síntese final ─────────────────────────────────────────────
async function synthesize(results, task) {
  const good = results.filter(r => r.ok && r.reply);
  if (!good.length) return 'Nenhum agente retornou resultado disponível.';
  if (good.length === 1) return good[0].reply;


  const combined = good
    .map(r => `### ${r.agentName}\n${r.reply.slice(0, 800)}`)
    .join('\n\n---\n\n');


  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3-70b-8192',
        temperature: 0.4,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: 'Você é o NEXIA SWARM SYNTHESIZER. Consolide as análises em uma resposta coesa, executiva e em português. Preserve os insights mais importantes de cada especialista. Identifique onde os agentes concordam e divergem.' },
          { role: 'user', content: `TAREFA: ${task.slice(0, 300)}\n\nRESPOSTAS ESPECIALIZADAS:\n${combined}\n\nSÍNTESE EXECUTIVA:` }
        ]
      })
    });
    if (!res.ok) return combined;
    const data = await res.json();
    return data.choices[0].message.content;
  } catch {
    return combined;
  }
}


// ── Handler ───────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };


  const guardErr = await guard(event, 'swarm', { skipTenant: true });
  if (guardErr) return guardErr;


  const t0 = Date.now();


  try {
    const { task: rawTask = '', tenantId = 'nexia', agents: forceAgents, mode: forceMode, userId } =
      JSON.parse(event.body || '{}');


    if (!rawTask.trim()) throw new Error('task é obrigatório');


    // Sanitiza o input
    const task = sanitizePrompt(rawTask);


    const allAgents = await loadAgents(tenantId);


    let plan;
    if (forceAgents?.length) {
      plan = { agents: forceAgents.slice(0, MAX_AGENTS), mode: forceMode || 'parallel' };
    } else {
      plan = await planAgents(task, allAgents);
    }


    // Filtra agentes disponíveis
    plan.agents = plan.agents.filter(k => allAgents[k]);
    if (!plan.agents.length) plan.agents = ['business'];


    if (process.env.NODE_ENV !== 'production') console.warn(`[SWARM] task:"${task.slice(0,50)}" agents:[${plan.agents}] mode:${plan.mode} tenant:${tenantId}`);


    const messages = [{ role: 'user', content: task }];
    const results  = plan.mode === 'sequential'
      ? await runSequential(plan.agents, allAgents, messages)
      : await runParallel(plan.agents, allAgents, messages);


    const synthesis = await synthesize(results, task);
    const actions   = results
      .filter(r => r.actionJson)
      .map(r => ({ agent: r.agentKey, ...r.actionJson }));


    const executionMs = Date.now() - t0;


    // Log de uso no Firestore
    if (tenantId) {
      db.collection('tenants').doc(tenantId).collection('cortex_logs').add({ ttl: admin.firestore.Timestamp.fromMillis(Date.now() + 2592000000),
        type: 'swarm_run', userId: userId || 'unknown',
        agents: plan.agents, mode: plan.mode, executionMs,
        ts: admin.firestore.FieldValue.serverTimestamp()
      }).catch(() => {});
    }


    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply:        synthesis,
        agentsUsed:   plan.agents,
        mode:         plan.mode,
        actions,
        executionMs,
        agentResults: results.map(r => ({
          agent: r.agentName, agentKey: r.agentKey,
          ok: r.ok, error: r.error || null,
          actionJson: r.actionJson || null
        }))
      })
    };


  } catch (err) {
    console.error('[SWARM] ❌', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};






