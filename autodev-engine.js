'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS — AUTODEV ENGINE v11.0                                 ║
 * ║  Gerador de Projetos Completos + Code Pipeline                   ║
 * ║  generate_project · review · fix · refactor · test · docs        ║
 * ╚══════════════════════════════════════════════════════════════════╝
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
const { guard, HEADERS, makeHeaders } = require('./middleware');

async function callCodeAI(systemPrompt, userPrompt, maxTokens) {
  maxTokens = maxTokens || 16000;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] })
      });
      if (res.ok) { const d = await res.json(); return { text: d.content?.[0]?.text || '', model: 'claude-sonnet-4-5' }; }
    } catch (e) { console.warn('[AUTODEV] Claude:', e.message); }
  }
  const deepKey = process.env.DEEPSEEK_API_KEY;
  if (deepKey) {
    try {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${deepKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-coder', max_tokens: Math.min(maxTokens, 8192), temperature: 0.1, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
      });
      if (res.ok) { const d = await res.json(); return { text: d.choices[0].message.content, model: 'deepseek-coder' }; }
    } catch (e) { console.warn('[AUTODEV] DeepSeek:', e.message); }
  }
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw new Error('Nenhuma API key disponível (ANTHROPIC_API_KEY, DEEPSEEK_API_KEY ou GROQ_API_KEY)');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama3-70b-8192', max_tokens: Math.min(maxTokens, 8192), temperature: 0.1, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
  });
  const d = await res.json();
  return { text: d.choices[0].message.content, model: 'llama3-70b-8192' };
}

function parseProjectFiles(rawText) {
  try {
    const cleaned = rawText.replace(/^```json\n?|^```\n?|\n?```$/gm, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.files && typeof parsed.files === 'object') return { meta: parsed, files: parsed.files };
    if (typeof parsed === 'object' && !Array.isArray(parsed)) return { meta: {}, files: parsed };
  } catch {}
  const files = {};
  const fileBlockRegex = /(?:###?\s*[`']?([^`'\n]+\.[a-zA-Z]{1,6})[`']?|\/\/\s*FILE:\s*([^\n]+)|\/\*\s*FILE:\s*([^\n]*)\*\/)\s*\n([\s\S]*?)(?=(?:\n###?\s*[`']?[^`'\n]+\.[a-zA-Z]{1,6}[`']?|\n\/\/\s*FILE:|\n\/\*\s*FILE:|$))/g;
  let match;
  while ((match = fileBlockRegex.exec(rawText)) !== null) {
    const filename = (match[1] || match[2] || match[3] || '').trim().replace(/^\/+/, '');
    const content = (match[4] || '').replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
    if (filename && content) files[filename] = content;
  }
  if (Object.keys(files).length > 0) return { meta: {}, files };
  return { meta: {}, files: { 'index.js': rawText } };
}

async function generateProject(description, projectType, stack, tenantId, userId) {
  const stackGuide = {
    'netlify-functions': 'Node.js 18, Netlify Functions, Firebase Admin SDK, fetch nativo. Estrutura: netlify/functions/*.js, package.json, netlify.toml',
    'react': 'React 18 + Vite, Tailwind CSS, componentes funcionais com hooks. Estrutura: src/components/, src/pages/, src/hooks/, index.html',
    'nextjs': 'Next.js 14 App Router, TypeScript, Tailwind CSS. Estrutura: app/, components/, lib/',
    'python': 'Python 3.11, FastAPI, Pydantic, type hints. Estrutura: main.py, routers/, models/, requirements.txt',
    'html': 'HTML5 puro, CSS3 com variáveis CSS e Grid/Flex, JavaScript ES2022 vanilla. Um único arquivo index.html ou separados.',
    'express': 'Node.js 18, Express 4, middleware helmet+cors+express-rate-limit, JWT auth. Estrutura: src/routes/, src/middleware/, src/models/',
    'auto': 'Detecte e escolha a melhor stack para o projeto'
  };

  const systemPrompt = `Você é o NEXIA AutoDev — o melhor arquiteto e desenvolvedor Full Stack do mundo.
Contexto: NEXIA OS é um SaaS multi-tenant com Firebase Auth + Firestore + Netlify Functions.

REGRAS ABSOLUTAS:
- Retorne SOMENTE um JSON válido com esta estrutura exata:
{
  "projectName": "nome-kebab-case",
  "description": "O que faz em uma frase",
  "stack": ["tech1", "tech2"],
  "setupInstructions": "Passos para instalar e rodar",
  "envVariables": { "VAR_NAME": "descrição do que é" },
  "files": {
    "caminho/arquivo.ext": "conteúdo 100% completo e funcional"
  }
}
- ZERO código incompleto, TODO, placeholder ou "..." 
- ZERO texto fora do JSON
- Comentários em português do Brasil
- Código pronto para produção real`;

  const userPrompt = `Gere o projeto completo:

DESCRIÇÃO: ${description}

TIPO: ${projectType || 'auto'}
STACK: ${stackGuide[stack] || stackGuide['auto']}

Seja extremamente completo — inclua TODOS os arquivos para o projeto funcionar do zero.`;

  const result = await callCodeAI(systemPrompt, userPrompt, 16000);
  const { meta, files } = parseProjectFiles(result.text);

  const projectId = `proj_${Date.now()}`;
  if (tenantId && userId) {
    try {
      await db.collection('tenants').doc(tenantId).collection('autodev_projects').doc(projectId).set({
        projectId,
        description,
        projectType: projectType || 'auto',
        stack: stack || 'auto',
        projectName: meta.projectName || projectId,
        fileCount: Object.keys(files).length,
        fileNames: Object.keys(files),
        modelUsed: result.model,
        userId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) { console.warn('[AUTODEV] Firestore save:', e.message); }
  }

  return { projectId, files, meta, model: result.model };
}

const PIPELINE = {
  review:   { sys: 'Você é um Tech Lead sênior. Analise o código em busca de bugs, vulnerabilidades (OWASP Top 10), problemas de performance e má práticas. Seja específico com linha quando possível.', fmt: 'Relatório em markdown: ## 🔴 Críticos | ## 🟡 Melhorias | ## ✅ Pontos Positivos' },
  fix:      { sys: 'Você é especialista em debugging. Corrija TODOS os erros mantendo a lógica original. Retorne o código COMPLETO corrigido.', fmt: 'Lista de correções aplicadas + código completo corrigido em bloco de código.' },
  refactor: { sys: 'Você é arquiteto de software. Refatore para Clean Code, SOLID, DRY. Performance e legibilidade primeiro.', fmt: 'Código refatorado completo com comentários explicando mudanças principais.' },
  test:     { sys: 'Você é especialista em QA. Gere testes unitários e de integração completos.', fmt: 'Arquivo de testes completo Jest/Vitest com casos de sucesso, erro e edge cases.' },
  docs:     { sys: 'Você é tech writer. Gere documentação técnica completa e clara.', fmt: 'JSDoc completo + README.md com instalação, uso, API reference e exemplos.' },
  explain:  { sys: 'Você é professor de programação. Explique o código de forma clara e didática.', fmt: 'Explicação em português, trecho por trecho, com analogias quando útil.' },
  optimize: { sys: 'Você é engenheiro de performance. Otimize para máxima velocidade e menor uso de memória.', fmt: 'Código otimizado com comentários sobre cada otimização e ganho esperado.' },
  security: { sys: 'Você é CISO virtual especialista em OWASP, LGPD e segurança web. Faça auditoria completa.', fmt: 'Relatório: vulnerabilidade encontrada | CVSS score | código vulnerável | código corrigido | mitigação.' },
};

exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    const g = await guard(event, 'autodev-engine');
  if (g) return g;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }
  const { action, code, language, context, description, projectType, stack, tenantId, userId } = body;

  try {
    if (action === 'generate_project') {
      if (!description) return { statusCode: 400, headers, body: JSON.stringify({ error: 'description é obrigatório' }) };
      const result = await generateProject(description, projectType, stack, tenantId, userId);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, action: 'generate_project', projectId: result.projectId, files: result.files, meta: result.meta, fileCount: Object.keys(result.files).length, modelUsed: result.model }) };
    }

    if (action === 'list_projects') {
      if (!tenantId || !userId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'tenantId e userId são obrigatórios' }) };
      const snap = await db.collection('tenants').doc(tenantId).collection('autodev_projects').where('userId', '==', userId).orderBy('createdAt', 'desc').limit(20).get();
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, projects: snap.docs.map(d => ({ id: d.id, ...d.data() })) }) };
    }

    const pipeline = PIPELINE[action];
    if (!pipeline) return { statusCode: 400, headers, body: JSON.stringify({ error: `Ação inválida: "${action}"`, validActions: ['generate_project', 'list_projects', ...Object.keys(PIPELINE)] }) };
    if (!code) return { statusCode: 400, headers, body: JSON.stringify({ error: 'code é obrigatório para esta ação' }) };

    const systemPrompt = `${pipeline.sys}\nFormato: ${pipeline.fmt}\nSempre responda em português do Brasil.`;
    const userPrompt = `Linguagem: ${language || 'auto-detect'}\n${context ? `Contexto: ${context}\n` : ''}Código:\n\`\`\`${language || ''}\n${code}\n\`\`\``;

    const result = await callCodeAI(systemPrompt, userPrompt, 12000);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, action, language, result: result.text, modelUsed: result.model }) };

  } catch (err) {
    console.error('[AUTODEV v11] ❌', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
