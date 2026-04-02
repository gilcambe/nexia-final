/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS v12 — FIREBASE SEED SCRIPT                          ║
 * ║  Inicializa: Tenants · Agentes · Store · Master User            ║
 * ║                                                                  ║
 * ║  COMO USAR:                                                      ║
 * ║  1. npm install firebase-admin                                   ║
 * ║  2. Coloque o JSON da service account em ./serviceAccount.json  ║
 * ║  3. node seed-firebase.js                                        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

'use strict';
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccount.json');

// Usa o project_id da própria service account — sem hardcode
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id
});

const db = admin.firestore();
const now = admin.firestore.FieldValue.serverTimestamp();

// ══════════════════════════════════════════════════════
// 1. TENANTS — estrutura base de todos os tenants
// ══════════════════════════════════════════════════════
const TENANTS = [
  {
    slug: 'nexia',
    name: 'NEXIA CORPORATION',
    plan: 'enterprise',
    theme: 'dark',
    role: 'master',
    modules: ['all'],
    maxMembers: -1,
    maxClients: -1,
    maxCortexDay: -1,
    active: true,
    email: 'admin@nexia.app',
    whatsapp: '',
    logoUrl: '',
    primaryColor: '#00e5ff',
  },
  {
    slug: 'viajante-pro',
    name: 'Viajante Pro',
    plan: 'pro',
    theme: 'dark',
    role: 'tenant',
    modules: ['turismo', 'financeiro', 'logistica'],
    maxMembers: 20,
    maxClients: 5000,
    maxCortexDay: 1000,
    active: true,
  },
  {
    slug: 'ces',
    name: 'CES Brasil 2027',
    plan: 'pro',
    theme: 'light',
    role: 'tenant',
    modules: ['eventos', 'matchmaking', 'compliance'],
    maxMembers: 20,
    maxClients: 5000,
    maxCortexDay: 1000,
    active: true,
  },
  {
    slug: 'bezsan',
    name: 'Bezsan Leilões',
    plan: 'starter',
    theme: 'dark',
    role: 'tenant',
    modules: ['leiloes', 'financeiro'],
    maxMembers: 5,
    maxClients: 500,
    maxCortexDay: 200,
    active: true,
  },
  {
    slug: 'splash',
    name: 'Splash Piscina e Lazer',
    plan: 'starter',
    theme: 'light',
    role: 'tenant',
    modules: ['crm', 'financeiro'],
    maxMembers: 5,
    maxClients: 500,
    maxCortexDay: 200,
    active: true,
  }
];

// ══════════════════════════════════════════════════════
// 2. AGENTES GLOBAIS — os 15 mil agentes que trabalham
//    (seeds os primeiros agentes base; os demais são
//     gerados programaticamente ou importados via batch)
// ══════════════════════════════════════════════════════
const GLOBAL_AGENTS = [
  // ── CORTEX CORE ──────────────────────────────────────
  {
    id: 'orchestrator',
    name: 'CORTEX Orchestrator',
    category: 'core',
    global: true,
    active: true,
    tenantId: 'nexia',
    systemPrompt: `Você é o CORTEX ORCHESTRATOR v10.1. Analise a mensagem e retorne SOMENTE JSON:
{ "type": "action|swarm|code|chat", "agents": [], "actions": [], "response": "...", "model_hint": "chat|code|analysis" }`,
    description: 'Orquestrador central — roteia todas as requisições',
    model: 'groq_llama3',
    maxTokens: 2000,
    temperature: 0.2,
  },
  // ── ESPECIALISTAS DE NEGÓCIO ─────────────────────────
  {
    id: 'business',
    name: 'Business Strategist',
    category: 'business',
    global: true,
    active: true,
    tenantId: 'nexia',
    systemPrompt: 'Você é um especialista em negócios, vendas e estratégia. Foque em ROI, conversão e crescimento. Responda em português, seja executivo e direto.',
    description: 'Estratégia de negócios, vendas e crescimento',
    model: 'groq_llama3',
    temperature: 0.5,
  },
  {
    id: 'finance_analyst',
    name: 'Finance Analyst',
    category: 'finance',
    global: true,
    active: true,
    tenantId: 'nexia',
    systemPrompt: 'Você é um analista financeiro sênior. Analisa fluxo de caixa, rentabilidade, riscos e oportunidades. Responda em português com dados concretos.',
    description: 'Análise financeira e planejamento',
    model: 'groq_mixtral',
    temperature: 0.3,
  },
  {
    id: 'dev',
    name: 'Senior Engineer',
    category: 'tech',
    global: true,
    active: true,
    tenantId: 'nexia',
    systemPrompt: 'Você é um Principal Engineer sênior. Resolve bugs, cria sistemas e escreve código limpo e seguro. Responda em português, seja técnico e preciso.',
    description: 'Engenharia de software e arquitetura',
    model: 'deepseek_coder',
    temperature: 0.2,
  },
  {
    id: 'security',
    name: 'CISO Virtual',
    category: 'security',
    global: true,
    active: true,
    tenantId: 'nexia',
    systemPrompt: 'Você é um CISO virtual. Identifica riscos, vulnerabilidades e propõe compliance. Responda em português, seja preciso e objetivo.',
    description: 'Segurança, compliance e gestão de riscos',
    model: 'groq_llama3',
    temperature: 0.2,
  },
  {
    id: 'legal',
    name: 'Legal Advisor',
    category: 'legal',
    global: true,
    active: true,
    tenantId: 'nexia',
    systemPrompt: 'Você é um consultor jurídico especializado em direito empresarial brasileiro. Analisa contratos, riscos legais e conformidade. Sempre recomende consultar um advogado para decisões finais.',
    description: 'Consultoria jurídica e análise de contratos',
    model: 'openai_gpt4o',
    temperature: 0.3,
  },
  {
    id: 'marketing',
    name: 'Marketing Growth',
    category: 'marketing',
    global: true,
    active: true,
    tenantId: 'nexia',
    systemPrompt: 'Você é um especialista em growth marketing e copywriting. Cria campanhas, copies persuasivos e estratégias de aquisição. Responda em português.',
    description: 'Marketing digital, copy e growth hacking',
    model: 'groq_mixtral',
    temperature: 0.7,
  },
  {
    id: 'data_analyst',
    name: 'Data Scientist',
    category: 'data',
    global: true,
    active: true,
    tenantId: 'nexia',
    systemPrompt: 'Você é um cientista de dados sênior. Analisa métricas, identifica padrões e gera insights acionáveis. Responda em português com dados e visualizações quando possível.',
    description: 'Análise de dados e insights de negócio',
    model: 'openai_gpt4o',
    temperature: 0.3,
  },
  {
    id: 'hr_coach',
    name: 'HR & People Coach',
    category: 'hr',
    global: true,
    active: true,
    tenantId: 'nexia',
    systemPrompt: 'Você é um especialista em RH, cultura organizacional e desenvolvimento de pessoas. Ajuda com contratação, onboarding, feedback e retenção. Responda em português.',
    description: 'Recursos humanos e desenvolvimento de equipes',
    model: 'groq_llama3',
    temperature: 0.5,
  },
  {
    id: 'ops_manager',
    name: 'Operations Manager',
    category: 'operations',
    global: true,
    active: true,
    tenantId: 'nexia',
    systemPrompt: 'Você é um gestor de operações especialista em processos, logística e eficiência. Identifica gargalos e propõe otimizações. Responda em português.',
    description: 'Gestão de operações e processos',
    model: 'groq_llama3',
    temperature: 0.4,
  },
  // ── AGENTES VERTICAIS (por módulo) ───────────────────
  {
    id: 'turismo_guide',
    name: 'Viajante Pro Guide',
    category: 'turismo',
    global: false,
    active: true,
    tenantId: 'viajante-pro',
    systemPrompt: 'Você é o guia virtual do Viajante Pro. Especialista em roteiros, hospedagem, passagens e logística de viagem no Brasil e exterior. Responda em português de forma amigável.',
    description: 'Especialista em turismo e roteiros',
    model: 'groq_llama3',
    temperature: 0.6,
  },
  {
    id: 'auction_analyst',
    name: 'Leilão Analyst',
    category: 'leiloes',
    global: false,
    active: true,
    tenantId: 'bezsan',
    systemPrompt: 'Você é um especialista em leilões judiciais e extrajudiciais. Analisa editais, riscos, débitos e potencial de lucro. Sempre alerte sobre riscos. Responda em português.',
    description: 'Análise de leilões e riscos jurídicos',
    model: 'openai_gpt4o',
    temperature: 0.2,
  },
];

// ══════════════════════════════════════════════════════
// 3. NEXIA STORE — Catálogo de módulos/produtos
// ══════════════════════════════════════════════════════
const STORE_CATALOG = [
  {
    id: 'module-crm-pro',
    name: 'CRM Pro',
    category: 'crm',
    description: 'CRM completo com kanban pipeline, automações e Cortex IA integrado.',
    price: 0,
    currency: 'BRL',
    billingType: 'included',
    active: true,
    features: ['Clientes ilimitados', 'Pipeline visual', 'Cortex integrado', 'Automações'],
    icon: 'ri-user-star-line',
  },
  {
    id: 'module-autodev',
    name: 'AutoDev Engine',
    category: 'dev',
    description: 'IA que revisa, corrige, refatora e documenta código automaticamente.',
    price: 0,
    currency: 'BRL',
    billingType: 'plan_pro',
    active: true,
    features: ['Review de código', 'Fix automático', 'Refactor', 'Geração de testes', 'JSDoc auto'],
    icon: 'ri-code-box-line',
    requiredPlan: 'pro',
  },
  {
    id: 'module-rag',
    name: 'RAG Engine — Documentos',
    category: 'ia',
    description: 'Upload de PDFs e documentos para o Cortex responder com base no seu conteúdo.',
    price: 0,
    currency: 'BRL',
    billingType: 'included',
    active: true,
    features: ['Upload de PDF', 'Chunking automático', 'Busca semântica', 'Context injection'],
    icon: 'ri-file-search-line',
  },
  {
    id: 'module-swarm',
    name: 'Swarm de Agentes',
    category: 'ia',
    description: 'Múltiplos agentes especializados trabalhando em paralelo na mesma tarefa.',
    price: 0,
    currency: 'BRL',
    billingType: 'plan_starter',
    active: true,
    features: ['Até 10 agentes simultâneos', 'Síntese automática', 'Agentes customizados'],
    icon: 'ri-team-line',
    requiredPlan: 'starter',
  },
  {
    id: 'module-voice',
    name: 'NEXIA Voice (ElevenLabs)',
    category: 'voice',
    description: 'Respostas do Cortex em voz natural com sotaque e personalidade configuráveis.',
    price: 197,
    currency: 'BRL',
    billingType: 'addon_monthly',
    active: false, // em desenvolvimento
    features: ['Voz natural ElevenLabs', 'Múltiplas vozes', 'Suporte a sotaques BR'],
    icon: 'ri-mic-line',
    comingSoon: true,
  },
  {
    id: 'module-arc',
    name: 'ARC — Architect AI',
    category: 'construction',
    description: 'Converte esboços em projetos 3D e gera orçamentos com preços de materiais em tempo real.',
    price: 497,
    currency: 'BRL',
    billingType: 'addon_monthly',
    active: false,
    features: ['Foto → vetor 3D', 'Orçamento dinâmico', 'Simulação visual', 'PDF técnico'],
    icon: 'ri-building-2-line',
    comingSoon: true,
  },
  {
    id: 'module-auction',
    name: 'AUCTION Intelligence',
    category: 'real_estate',
    description: 'Robô que varre leilões judiciais, analisa riscos jurídicos e calcula lucro potencial.',
    price: 397,
    currency: 'BRL',
    billingType: 'addon_monthly',
    active: false,
    features: ['Scraping de leilões', 'Análise de editais IA', 'Score de risco', 'Alerta de oportunidades'],
    icon: 'ri-auction-line',
    comingSoon: true,
  },
  {
    id: 'module-observability',
    name: 'Observability Pro',
    category: 'infra',
    description: 'Dashboard de saúde do sistema, latências, custos de IA e alertas automáticos.',
    price: 0,
    currency: 'BRL',
    billingType: 'plan_pro',
    active: true,
    features: ['Health checks', 'Latência por modelo', 'Custo estimado de API', 'Alertas'],
    icon: 'ri-pulse-line',
    requiredPlan: 'pro',
  },
];

// ══════════════════════════════════════════════════════
// SEED RUNNER
// ══════════════════════════════════════════════════════
async function seed() {
  console.log('\n🚀 NEXIA OS — Iniciando seed do Firebase...\n');

  // 1. Tenants
  console.log('📦 Criando tenants...');
  for (const tenant of TENANTS) {
    const { slug, ...data } = tenant;
    await db.collection('tenants').doc(slug).set({
      ...data,
      slug,
      createdAt: now,
      updatedAt: now,
    }, { merge: true });
    console.log(`  ✅ Tenant: ${slug}`);
  }

  // 2. Agentes globais
  console.log('\n🤖 Criando agentes...');
  for (const agent of GLOBAL_AGENTS) {
    const { id, ...data } = agent;
    await db.collection('agents').doc(id).set({
      ...data,
      createdAt: now,
      updatedAt: now,
    }, { merge: true });
    console.log(`  ✅ Agente: ${agent.name} [${agent.category}]`);
  }

  // 3. Store catalog
  console.log('\n🏪 Criando catálogo da NEXIA STORE...');
  for (const item of STORE_CATALOG) {
    const { id, ...data } = item;
    await db.collection('store_catalog').doc(id).set({
      ...data,
      createdAt: now,
      updatedAt: now,
    }, { merge: true });
    console.log(`  ✅ Módulo: ${item.name}`);
  }

  // 4. Configurações do sistema
  console.log('\n⚙️  Configurando sistema...');
  await db.collection('tenants').doc('nexia').collection('config').doc('system').set({
    version: '10.1.0',
    multiModelEnabled: true,
    swarmEnabled: true,
    autodevEnabled: true,
    ragEnabled: true,
    maxSwarmAgents: 10,
    defaultModel: 'groq_llama3',
    fallbackModel: 'groq_llama3_fast',
    updatedAt: now,
  }, { merge: true });

  await db.collection('tenants').doc('nexia').collection('config').doc('brand').set({
    name: 'NEXIA OS',
    tagline: 'A Inteligência que trabalha por você',
    primaryColor: '#00e5ff',
    accentColor: '#a855f7',
    logoUrl: '',
    faviconUrl: '',
    updatedAt: now,
  }, { merge: true });

  console.log('  ✅ Config do sistema salva');

  // 5. Health check document
  await db.collection('health').doc('status').set({
    status: 'ok',
    version: '31.0.0',
    seededAt: now,
    tenants: TENANTS.length,
    agents: GLOBAL_AGENTS.length,
    storeModules: STORE_CATALOG.length,
  });
  console.log('  ✅ Health check inicializado');

  // ══════════════════════════════════════════════════════
  // 6. SALES AGENT CONFIG por tenant
  // ══════════════════════════════════════════════════════
  console.log('\n📊 6. Sales Agent config...');
  const salesConfigs = [
    { tenantId: 'nexia',       agentName: 'ARIA',   companyName: 'NEXIA OS',        accentColor: '#00e5ff', pitch: 'NEXIA OS é uma plataforma de IA que automatiza vendas, CRM, financeiro e operações.' },
    { tenantId: 'bezsan',      agentName: 'ÁGATA',  companyName: 'Bezsan Leilões',   accentColor: '#DAA520', pitch: 'Bezsan Leilões oferece os melhores leilões judiciais do Brasil com due diligence por IA.' },
    { tenantId: 'ces',         agentName: 'SOFIA',  companyName: 'CES Brasil 2027',  accentColor: '#3b82f6', pitch: 'CES Brasil 2027 é a maior missão empresarial brasileira para o Consumer Electronics Show.' },
    { tenantId: 'viajante-pro',agentName: 'LUNA',   companyName: 'Viajante Pro',     accentColor: '#8b5cf6', pitch: 'Viajante Pro organiza sua viagem internacional de A a Z com suporte 24/7.' },
    { tenantId: 'splash',      agentName: 'NOVA',   companyName: 'Splash Eventos',   accentColor: '#06b6d4', pitch: 'Splash cria experiências únicas de eventos com tecnologia e criatividade.' },
  ];
  for (const cfg of salesConfigs) {
    await db.collection('tenants').doc(cfg.tenantId)
      .collection('config').doc('sales_agent').set({ ...cfg, updatedAt: now }, { merge: true });
    console.log(`  ✅ Sales Agent config: ${cfg.tenantId} → ${cfg.agentName}`);
  }

  // ══════════════════════════════════════════════════════
  // 7. EMPIRE METRICS — snapshot inicial
  // ══════════════════════════════════════════════════════
  console.log('\n📊 7. Empire metrics inicial...');
  const thisMonth = new Date().toISOString().slice(0, 7);
  await db.collection('empire_metrics').add({
    month: thisMonth,
    mrr: 0, arr: 0, ltv: 0,
    churnRate: 0, mrrGrowth: 0, nrr: 100,
    activeTenants: TENANTS.length,
    newThisMonth: TENANTS.length,
    churnedThisMonth: 0,
    topTenants: [],
    ts: now,
    note: 'seed inicial'
  });
  console.log('  ✅ Snapshot de métricas criado');

  // ══════════════════════════════════════════════════════
  // 8. QA REPORTS collection init
  // ══════════════════════════════════════════════════════
  await db.collection('qa_reports').add({
    health: 'HEALTHY', passed: 0, failed: 0, avgLatency: 0,
    tests: [], note: 'seed inicial', ts: now
  });
  console.log('  ✅ QA reports inicializado');

  // ══════════════════════════════════════════════════════
  // 9. SYSTEM HEALTH init
  // ══════════════════════════════════════════════════════
  await db.collection('system_health').add({
    health: 'HEALTHY',
    results: { qa: { health: 'HEALTHY' }, security: { status: 'SECURE' } },
    note: 'seed inicial', ts: now
  });
  console.log('  ✅ System health inicializado');

  console.log('\n✨ SEED v31 COMPLETO!\n');
  console.log('📊 Resumo:');
  console.log(`   Tenants: ${TENANTS.length}`);
  console.log(`   Agentes: ${GLOBAL_AGENTS.length}`);
  console.log(`   Módulos na Store: ${STORE_CATALOG.length}`);
  console.log(`   Sales Agent configs: ${salesConfigs.length}`);
  console.log('\n⚠️  PRÓXIMO PASSO:');
  console.log('   1. firebase deploy --only firestore:rules,firestore:indexes,storage');
  console.log('   2. node set-master-role.js SEU@email.com');
  console.log('   3. Configure env vars no Netlify');
  console.log('   4. Acesse /nexia/nexia-master-admin.html e veja os KPIs reais');

  process.exit(0);
}

seed().catch(err => {
  console.error('❌ Erro no seed:', err);
  process.exit(1);
});
