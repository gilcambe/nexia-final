// ═══════════════════════════════════════════════════════════════
// NEXIA Arquiteto IA — Onboarding inteligente
// Detecta o setor do tenant e monta o painel com módulos relevantes
// POST /api/architect
// Body: { tenantId, sector?, description?, answers? }
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

// ── Módulos por setor (mapeamento estratégico) ──────────────────
const SECTOR_MODULES = {
  eventos: {
    label: 'Eventos & Festas',
    modules: ['checkin-qr', 'nexia-scheduler', 'mini-site', 'spl-overbooking', 'nexia-broadcast', 'nexia-pay-split', 'ces-matchmaking', 'nexia-contracts', 'catraca-iot', 'nexia-inbox'],
    priority: ['spl-overbooking', 'checkin-qr', 'nexia-scheduler'],
    persona: 'organizador de eventos'
  },
  leiloes: {
    label: 'Leilões & Investimentos',
    modules: ['cortex-due', 'cortex-sniper', 'bez-scraper', 'bez-blockchain', 'nexia-contracts', 'osint-hub', 'cortex-analytics', 'nexia-cobranca'],
    priority: ['cortex-due', 'bez-scraper', 'cortex-sniper'],
    persona: 'investidor em leilões'
  },
  turismo: {
    label: 'Turismo & Viagens',
    modules: ['vp-rooming', 'vp-sos', 'nexia-scheduler', 'nexia-broadcast', 'pabx-cloud', 'cortex-predictive', 'nexia-contracts', 'nexia-inbox'],
    priority: ['vp-sos', 'vp-rooming', 'nexia-scheduler'],
    persona: 'agência de viagens'
  },
  saas: {
    label: 'SaaS & Tecnologia',
    modules: ['cortex-copilot', 'multi-model', 'rag-engine', 'mrr-dashboard', 'cortex-analytics', 'nexia-cobranca', 'lgpd-compliance', '2fa-module', 'nexia-flow', 'swarm-control'],
    priority: ['cortex-copilot', 'mrr-dashboard', 'nexia-cobranca'],
    persona: 'fundador de SaaS'
  },
  comercio: {
    label: 'Comércio & Varejo',
    modules: ['whatsapp-api', 'nexia-broadcast', 'nexia-loyalty', 'nfe-modulo', 'cortex-sdr', 'nexia-pay-split', 'nexia-forms', 'cortex-analytics', 'nexia-inbox'],
    priority: ['whatsapp-api', 'cortex-sdr', 'nexia-loyalty'],
    persona: 'dono de comércio'
  },
  saude: {
    label: 'Saúde & Clínicas',
    modules: ['nexia-scheduler', 'nexia-forms', 'lgpd-compliance', 'nexia-broadcast', 'nexia-cobranca', 'pabx-cloud', 'nexia-contracts', 'nexia-inbox', '2fa-module'],
    priority: ['nexia-scheduler', 'lgpd-compliance', 'nexia-broadcast'],
    persona: 'gestor de clínica'
  },
  educacao: {
    label: 'Educação & Treinamentos',
    modules: ['checkin-qr', 'nexia-forms', 'nexia-broadcast', 'nexia-scheduler', 'mini-site', 'nexia-loyalty', 'cortex-copilot', 'rag-engine'],
    priority: ['cortex-copilot', 'nexia-forms', 'nexia-broadcast'],
    persona: 'gestor educacional'
  },
  logistica: {
    label: 'Logística & Distribuição',
    modules: ['nexia-flow', 'nexia-broadcast', 'sms-gateway', 'nfe-modulo', 'cortex-analytics', 'nexia-api-gateway', 'nexia-inbox'],
    priority: ['nexia-flow', 'nfe-modulo', 'nexia-broadcast'],
    persona: 'gestor de logística'
  },
  financeiro: {
    label: 'Financeiro & Contabilidade',
    modules: ['nfe-modulo', 'nexia-cobranca', 'nexia-pay-split', 'mrr-dashboard', 'lgpd-compliance', '2fa-module', 'nexia-backup', 'relatorios'],
    priority: ['nfe-modulo', 'nexia-cobranca', 'mrr-dashboard'],
    persona: 'controller financeiro'
  }
};

// ── Perguntas de diagnóstico ────────────────────────────────────
const DIAGNOSTIC_QUESTIONS = [
  {
    id: 'q1',
    question: 'Qual é o principal tipo do seu negócio?',
    options: [
      { value: 'eventos', label: '🎉 Eventos, festas e locação de espaços' },
      { value: 'leiloes', label: '🏛️ Leilões, investimentos e imóveis' },
      { value: 'turismo', label: '✈️ Turismo, viagens e excursões' },
      { value: 'saas', label: '💻 Software, SaaS ou tecnologia' },
      { value: 'comercio', label: '🛍️ Comércio, varejo ou e-commerce' },
      { value: 'saude', label: '🏥 Saúde, clínicas ou consultórios' },
      { value: 'educacao', label: '📚 Educação, treinamentos ou cursos' },
      { value: 'logistica', label: '🚚 Logística, transporte ou distribuição' },
      { value: 'financeiro', label: '💰 Financeiro, contabilidade ou gestão' }
    ]
  },
  {
    id: 'q2',
    question: 'Qual é o seu maior desafio operacional hoje?',
    options: [
      { value: 'captacao', label: 'Captar e converter mais clientes' },
      { value: 'retencao', label: 'Reter clientes e reduzir churn' },
      { value: 'operacao', label: 'Automatizar processos manuais' },
      { value: 'financas', label: 'Controlar receita e inadimplência' },
      { value: 'comunicacao', label: 'Melhorar comunicação com clientes' }
    ]
  },
  {
    id: 'q3',
    question: 'Quantos clientes ativos você tem hoje?',
    options: [
      { value: 'micro', label: 'Menos de 100' },
      { value: 'pequeno', label: '100 a 500' },
      { value: 'medio', label: '500 a 2.000' },
      { value: 'grande', label: 'Mais de 2.000' }
    ]
  }
];

const { requireBearerAuth, makeHeaders} = require('./middleware');

exports.handler = async (event) => {
  const headers = makeHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  // CORRIGIDO v38: criação de tenant requer autenticação master
    const _authErr = await requireBearerAuth(event);
  if (_authErr) return _authErr;
  if (event.httpMethod === 'GET') {
    // Return diagnostic questions
    return { statusCode: 200, headers, body: JSON.stringify({ questions: DIAGNOSTIC_QUESTIONS }) };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { tenantId, action, answers, description, forceRebuild } = body;

    if (!tenantId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'tenantId required' }) };

    // ── ACTION: analyze — AI detects sector from free text ──
    if (action === 'analyze' && description) {
      const sector = await detectSectorWithAI(description);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ sector, label: SECTOR_MODULES[sector]?.label, detectedFrom: 'ai' })
      };
    }

    // ── ACTION: generate — Build panel recommendations from answers ──
    if (action === 'generate' && answers) {
      const sector = answers.q1 || 'saas';
      const challenge = answers.q2 || 'operacao';
      const size = answers.q3 || 'pequeno';

      const sectorConfig = SECTOR_MODULES[sector] || SECTOR_MODULES.saas;
      const recommendation = await generateRecommendationWithAI(sectorConfig, challenge, size, answers);

      // Persist onboarding state in Firestore
      await db.collection('tenants').doc(tenantId).collection('onboarding').doc('architect').set({
        sector,
        sectorLabel: sectorConfig.label,
        challenge,
        size,
        answers,
        recommendedModules: recommendation.modules,
        priorityModules: recommendation.priority,
        explanation: recommendation.explanation,
        completedAt: new Date().toISOString(),
        version: 'v1'
      }, { merge: true });

      // Auto-enable priority modules in tenant config
      if (!forceRebuild) {
        const tenantRef = db.collection('tenants').doc(tenantId);
        await tenantRef.set({
          enabledModules: recommendation.priority,
          sector,
          onboardingComplete: true,
          onboardingCompletedAt: new Date().toISOString()
        }, { merge: true });
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          success: true,
          sector,
          sectorLabel: sectorConfig.label,
          recommendedModules: recommendation.modules,
          priorityModules: recommendation.priority,
          explanation: recommendation.explanation,
          autoEnabled: recommendation.priority
        })
      };
    }

    // ── ACTION: status — Get current onboarding state ──
    if (action === 'status') {
      const doc = await db.collection('tenants').doc(tenantId).collection('onboarding').doc('architect').get();
      if (!doc.exists) return { statusCode: 200, headers, body: JSON.stringify({ complete: false }) };
      return { statusCode: 200, headers, body: JSON.stringify({ complete: true, ...doc.data() }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action. Use: analyze, generate, status' }) };

  } catch (err) {
    console.error('Architect error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

// ── AI: Detect sector from free text description ────────────────
async function detectSectorWithAI(description) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return fallbackSectorDetection(description);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [{
          role: 'user',
          content: `Analise esta descrição de negócio e retorne APENAS uma palavra do seguinte conjunto: eventos, leiloes, turismo, saas, comercio, saude, educacao, logistica, financeiro.

Descrição: "${description}"

Responda APENAS com uma palavra.`
        }]
      })
    });
    const data = await res.json();
    const detected = data.content?.[0]?.text?.trim().toLowerCase().split('\n')[0];
    const valid = Object.keys(SECTOR_MODULES);
    return valid.includes(detected) ? detected : fallbackSectorDetection(description);
  } catch (e) {
    return fallbackSectorDetection(description);
  }
}

// ── AI: Generate personalized module recommendation ─────────────
async function generateRecommendationWithAI(sectorConfig, challenge, size, answers) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const baseModules = sectorConfig.modules;
  const basePriority = sectorConfig.priority;

  if (!ANTHROPIC_KEY) {
    return {
      modules: baseModules,
      priority: basePriority,
      explanation: `Para um ${sectorConfig.persona} com foco em ${challenge}, recomendamos começar com os módulos: ${basePriority.join(', ')}. Eles resolverão seus principais desafios imediatamente.`
    };
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Você é o Arquiteto do NEXIA OS, um sistema SaaS multi-tenant.

Perfil do tenant:
- Setor: ${sectorConfig.label}
- Persona: ${sectorConfig.persona}
- Principal desafio: ${challenge}
- Tamanho: ${size} clientes ativos

Módulos disponíveis para este setor: ${baseModules.join(', ')}
Módulos prioritários sugeridos: ${basePriority.join(', ')}

Escreva uma explicação CURTA (máximo 3 frases) em português do Brasil, no tom de um consultor de negócios experiente, explicando por que esses 3 módulos prioritários são os melhores para começar. Mencione benefícios concretos como tempo economizado ou receita gerada. Seja direto e objetivo.`
        }]
      })
    });
    const data = await res.json();
    const explanation = data.content?.[0]?.text?.trim() || '';

    return { modules: baseModules, priority: basePriority, explanation };
  } catch (e) {
    return {
      modules: baseModules,
      priority: basePriority,
      explanation: `Para um ${sectorConfig.persona}, os módulos ${basePriority.join(', ')} são a base ideal: resolvem os problemas mais urgentes do seu setor imediatamente.`
    };
  }
}

// ── Fallback: keyword-based sector detection ────────────────────
function fallbackSectorDetection(text) {
  const t = text.toLowerCase();
  if (/leil[aã]o|arremate|imóvel|judicial/.test(t)) return 'leiloes';
  if (/viag|turism|passageiro|tour|excurs/.test(t)) return 'turismo';
  if (/event|festa|salão|chácara|casamento|form/.test(t)) return 'eventos';
  if (/clínica|saúde|médic|dentist|consulto/.test(t)) return 'saude';
  if (/software|saas|tech|aplicativo|sistema|api/.test(t)) return 'saas';
  if (/loja|varejo|e-commerce|produto|vend/.test(t)) return 'comercio';
  if (/curso|aula|escola|treinamento|educ/.test(t)) return 'educacao';
  if (/logístic|transport|entrega|frete|distribuição/.test(t)) return 'logistica';
  if (/contabil|financ|fiscal|nota|imposto/.test(t)) return 'financeiro';
  return 'saas';
}
