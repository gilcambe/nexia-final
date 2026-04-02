/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS — AGENT FACTORY v7.0                              ║
 * ║  Cria, gerencia e ativa agentes dinamicamente               ║
 * ║  Armazena em Firestore: agents/{agentId}                    ║
 * ╚══════════════════════════════════════════════════════════════╝
 */
'use strict';

const NexiaAgentFactory = (() => {

  // ── Templates de agentes pré-definidos ────────────────────────
  const AGENT_TEMPLATES = {
    business: {
      id:          'business',
      name:        'BUSINESS_AGENT',
      displayName: 'Estrategista de Negócios',
      description: 'Analisa dados com visão de ROI, cria leads e estratégias',
      type:        'business',
      model:       'llama-3.3-70b-versatile',
      temperature: 0.8,
      icon:        '📈',
      capabilities: ['create_lead', 'analyze_pipeline', 'roi_analysis']
    },
    dev: {
      id:          'dev',
      name:        'DEV_AGENT',
      displayName: 'Principal Engineer',
      description: 'Arquitetura, código, bugs e tarefas técnicas',
      type:        'dev',
      model:       'llama-3.3-70b-versatile',
      temperature: 0.4,
      icon:        '⚙️',
      capabilities: ['create_task', 'code_review', 'architecture']
    },
    security: {
      id:          'security',
      name:        'SECURITY_AGENT',
      displayName: 'CISO Virtual',
      description: 'Segurança, vulnerabilidades e compliance',
      type:        'security',
      model:       'llama-3.3-70b-versatile',
      temperature: 0.2,
      icon:        '🔒',
      capabilities: ['create_security_alert', 'vulnerability_scan', 'compliance']
    }
  };

  // ── Garante que os agentes padrão existem no Firestore ────────
  async function seedDefaultAgents() {
    if (!NEXIA.db) return;
    const batch = NEXIA.db.batch();
    for (const [key, tmpl] of Object.entries(AGENT_TEMPLATES)) {
      const ref = NEXIA.db.collection('agents').doc(key);
      const snap = await ref.get().catch(() => null);
      if (!snap || !snap.exists) {
        batch.set(ref, {
          ...tmpl,
          status:    'sleeping',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          runCount:  0,
          lastRun:   null
        });
      }
    }
    await batch.commit().catch(() => {});
  }

  // ── Cria um agente customizado ─────────────────────────────────
  async function create(config) {
    if (!NEXIA.db) throw new Error('Firestore não disponível');
    const id  = config.id || ('agent_' + Date.now().toString(36));
    const ref = NEXIA.db.collection('agents').doc(id);
    const data = {
      id,
      name:        config.name        || id.toUpperCase(),
      displayName: config.displayName || config.name || id,
      description: config.description || '',
      type:        config.type        || 'custom',
      model:       config.model       || 'llama-3.3-70b-versatile',
      temperature: config.temperature ?? 0.7,
      systemPrompt: config.systemPrompt || '',
      icon:        config.icon        || '🤖',
      capabilities: config.capabilities || [],
      status:      'sleeping',
      runCount:    0,
      lastRun:     null,
      createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt:   firebase.firestore.FieldValue.serverTimestamp()
    };
    await ref.set(data);
    console.log(`[AGENT FACTORY] Agente criado: ${id}`);
    return { id, ...data };
  }

  // ── Lista todos os agentes ────────────────────────────────────
  async function list() {
    if (!NEXIA.db) return [];
    const snap = await NEXIA.db.collection('agents').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  // ── Observa agentes em tempo real ────────────────────────────
  function watch(callback) {
    if (!NEXIA.db) return () => {};
    return NEXIA.db.collection('agents').onSnapshot(snap => {
      callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }

  // ── Observa jobs do Swarm em tempo real (cortex_jobs) ─────────
  function watchJobs(callback) {
    if (!NEXIA.db) return () => {};
    return NEXIA.db.collection('cortex_jobs')
      .orderBy('createdAt', 'desc')
      .limit(50)
      .onSnapshot(snap => {
        callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      });
  }

  // ── Ativa agente (sleeping → active) ─────────────────────────
  async function activate(agentId) {
    if (!NEXIA.db) return;
    await NEXIA.db.collection('agents').doc(agentId).update({
      status:    'active',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  // ── Coloca agente de volta a dormir após execução ─────────────
  async function sleep(agentId) {
    if (!NEXIA.db) return;
    await NEXIA.db.collection('agents').doc(agentId).update({
      status:    'sleeping',
      lastRun:   firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  // ── Incrementa contador de execuções ─────────────────────────
  async function incrementRunCount(agentId) {
    if (!NEXIA.db) return;
    await NEXIA.db.collection('agents').doc(agentId).update({
      runCount:  firebase.firestore.FieldValue.increment(1),
      lastRun:   firebase.firestore.FieldValue.serverTimestamp(),
      status:    'sleeping',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  // ── Deleta agente customizado ─────────────────────────────────
  async function remove(agentId) {
    if (!NEXIA.db) return;
    const PROTECTED = ['business', 'dev', 'security'];
    if (PROTECTED.includes(agentId)) throw new Error('Agentes padrão não podem ser removidos');
    await NEXIA.db.collection('agents').doc(agentId).delete();
  }

  // ── Dispara tarefa no Swarm via API ───────────────────────────
  async function dispatchSwarmTask(task, options = {}) {
    const { agents, mode, tenantId } = options;
    try {
      const res = await fetch('/.netlify/functions/swarm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task,
          tenantId: tenantId || NEXIA.currentTenant?.slug || 'nexia',
          agents,
          mode
        })
      });
      if (!res.ok) throw new Error(`Swarm error: HTTP ${res.status}`);
      return res.json();
    } catch (err) {
      console.error('[AgentFactory] dispatchSwarmTask failed:', err.message);
      throw err;
    }
  }

  // ── Init: seed agentes padrão ─────────────────────────────────
  NEXIA.onReady(() => {
    if (NEXIA.auth) {
      NEXIA.auth.onAuthStateChanged(user => {
        if (user) seedDefaultAgents();
      });
    }
  });

  return {
    create,
    list,
    watch,
    watchJobs,
    activate,
    sleep,
    remove,
    incrementRunCount,
    dispatchSwarmTask,
    templates: AGENT_TEMPLATES
  };
})();

window.NexiaAgentFactory = NexiaAgentFactory;
