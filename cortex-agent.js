/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  NEXIA OS — CORTEX AGENT v9.0                       ║
 * ║  Agent Loop com Tool-Use real                       ║
 * ║  Tools: createFile, readFile, editFile,             ║
 * ║         createTask, searchKnowledge, analyzeCode    ║
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
const { guard, sanitizePrompt, HEADERS, makeHeaders } = require('./middleware');


const JOB_TIMEOUT_MS  = 55_000;
const MAX_TOOL_CALLS  = 8;   // máximo de tool calls por job


// ── Definição das ferramentas disponíveis ─────────────────────
const TOOLS_DEFINITION = `
Você tem acesso às seguintes ferramentas. Para usar uma ferramenta, responda com:
<tool_call>
{"tool": "NOME_DA_FERRAMENTA", "args": {...}}
</tool_call>


FERRAMENTAS DISPONÍVEIS:


1. createFile - Cria um arquivo no workspace do tenant
   args: { path: string, content: string, description: string }


2. readFile - Lê um arquivo existente no workspace
   args: { path: string }


3. editFile - Edita um arquivo existente (substitui conteúdo)
   args: { path: string, content: string, reason: string }


4. listFiles - Lista arquivos no workspace
   args: { folder?: string }


5. createTask - Cria uma tarefa no CRM
   args: { titulo: string, descricao: string, responsavel?: string, prioridade?: "baixa"|"media"|"alta" }


6. searchKnowledge - Busca na base de conhecimento do tenant
   args: { query: string }


7. analyzeCode - Analisa código e retorna problemas/sugestões
   args: { code: string, language: string }


8. runTests - Simula a execução de testes para um arquivo
   args: { path: string, testType?: "unit"|"integration" }


Após usar uma ferramenta, analise o resultado e continue até completar a tarefa.
Quando terminar, responda sem tag <tool_call>.
`;


// ── Executa uma ferramenta ────────────────────────────────────
async function executeTool(toolName, args, tenantId, userId) {
  const workspacePath = `tenants/${tenantId}/workspace`;


  switch (toolName) {
    case 'createFile': {
      const { path, content, description = '' } = args;
      if (!path || !content) throw new Error('createFile: path e content são obrigatórios');
      const safePath = path.replace(/\.\./g, '').replace(/^\//, '').slice(0, 200);
      const docId    = safePath.replace(/[/.\s]/g, '_').slice(0, 100);


      await db.collection(workspacePath).doc(docId).set({
        path: safePath,
        content: content.slice(0, 50000),
        description,
        size:      content.length,
        createdBy: userId,
        tenantId,
        createdAt: now(),
        updatedAt: now()
      });
      return { ok: true, path: safePath, size: content.length };
    }


    case 'readFile': {
      const { path } = args;
      if (!path) throw new Error('readFile: path é obrigatório');
      const docId = path.replace(/[/.\s]/g, '_').slice(0, 100);
      const snap  = await db.collection(workspacePath).doc(docId).get();
      if (!snap.exists) throw new Error(`Arquivo não encontrado: ${path}`);
      const data = snap.data();
      return { ok: true, path, content: data.content, size: data.size };
    }


    case 'editFile': {
      const { path, content, reason = '' } = args;
      if (!path || !content) throw new Error('editFile: path e content são obrigatórios');
      const docId = path.replace(/[/.\s]/g, '_').slice(0, 100);
      const snap  = await db.collection(workspacePath).doc(docId).get();
      if (!snap.exists) throw new Error(`Arquivo não encontrado: ${path}`);


      // Salva versão anterior para histórico
      const prev = snap.data().content;
      await db.collection(workspacePath).doc(docId).update({
        content:   content.slice(0, 50000),
        size:      content.length,
        reason,
        updatedBy: userId,
        updatedAt: now(),
        prevSize:  prev?.length || 0
      });
      return { ok: true, path, oldSize: prev?.length || 0, newSize: content.length };
    }


    case 'listFiles': {
      const { folder = '' } = args;
      const snap = await db.collection(workspacePath)
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();


      const files = snap.docs
        .map(d => ({ path: d.data().path, size: d.data().size, updatedAt: d.data().updatedAt }))
        .filter(f => !folder || f.path.startsWith(folder));


      return { ok: true, files, total: files.length };
    }


    case 'createTask': {
      const { titulo, descricao = '', responsavel = 'dev-team', prioridade = 'media' } = args;
      if (!titulo) throw new Error('createTask: titulo é obrigatório');


      const ref = await db.collection('tenants').doc(tenantId).collection('tasks').add({
        titulo: titulo.slice(0, 200),
        descricao: descricao.slice(0, 2000),
        responsavel,
        prioridade,
        status:    'pending',
        origem:    'CORTEX_AGENT',
        createdBy: userId,
        tenantId,
        _deleted:  false,
        createdAt: now(),
        updatedAt: now()
      });
      return { ok: true, taskId: ref.id, titulo };
    }


    case 'searchKnowledge': {
      const { query } = args;
      if (!query) throw new Error('searchKnowledge: query é obrigatório');


      // Busca em cortex_good_responses do tenant
      const snap = await db.collection('cortex_good_responses')
        .doc(tenantId).collection('examples')
        .where('rating', '>=', 4)
        .orderBy('rating', 'desc')
        .limit(20)
        .get();


      const results = snap.docs
        .map(d => ({ prompt: d.data().prompt, response: d.data().response }))
        .filter(r => {
          const q = query.toLowerCase();
          return r.prompt.toLowerCase().includes(q) || r.response.toLowerCase().includes(q);
        })
        .slice(0, 5);


      return { ok: true, results, total: results.length };
    }


    case 'analyzeCode': {
      const { code, language = 'javascript' } = args;
      if (!code) throw new Error('analyzeCode: code é obrigatório');


      // Chama IA para análise de código
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama3-70b-8192',
          temperature: 0.1,
          max_tokens: 800,
          messages: [
            { role: 'system', content: 'Você analisa código e retorna: problemas críticos, melhorias de segurança, melhorias de performance, e um score de 0-10. Seja conciso. Responda em português.' },
            { role: 'user', content: `Linguagem: ${language}\n\nCódigo:\n\`\`\`\n${code.slice(0, 3000)}\n\`\`\`` }
          ]
        })
      });
      if (!res.ok) throw new Error('Falha na análise de código');
      const data   = await res.json();
      return { ok: true, analysis: data.choices[0].message.content };
    }


    case 'runTests': {
      const { path, testType = 'unit' } = args;
      // Simulação de testes — retorna resultado plausível
      return {
        ok: true,
        path,
        testType,
        status: 'simulated',
        message: `Para executar testes reais de ${testType} em "${path}", configure um runner de CI/CD (GitHub Actions, Netlify build hooks, etc.) com os scripts definidos no package.json.`,
        suggestion: 'Use node tests/run-tests.js para testes de integração das Netlify functions.'
      };
    }


    default:
      throw new Error(`Ferramenta desconhecida: "${toolName}"`);
  }
}


// ── Parseia tool calls da resposta da IA ──────────────────────
function parseToolCall(text) {
  const match = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}


// ── Loop de agente com tool-use ───────────────────────────────
async function runAgentLoop(jobId, task, agentType, tenantId, userId) {
  const jobRef    = db.collection('cortex_jobs').doc(jobId);
  const steps     = [];
  const t0        = Date.now();
  let   toolCalls = 0;


  const addStep = async (name, result, status = 'done') => {
    steps.push({ name, status, result: typeof result === 'string' ? result : JSON.stringify(result).slice(0, 500) });
    await jobRef.update({ steps, currentStep: name, updatedAt: now() }).catch(() => {});
  };


  const messages = [{ role: 'user', content: task }];


  try {
    // Sistema do agente baseado no tipo
    const systems = {
      dev:      `Você é o NEXIA DEV AGENT — Principal Engineer sênior.\n${TOOLS_DEFINITION}\nResponda em português. Seja preciso, escreva código real e funcional.`,
      business: `Você é o NEXIA BUSINESS AGENT — Estrategista sênior.\n${TOOLS_DEFINITION}\nResponda em português. Foque em ROI e resultados mensuráveis.`,
      default:  `Você é o NEXIA CORTEX AGENT.\n${TOOLS_DEFINITION}\nResponda em português. Conclua a tarefa com precisão.`
    };
    const systemPrompt = systems[agentType] || systems.default;


    await addStep('Iniciando agente', { agentType, task: task.slice(0, 200) });


    // Loop de tool-use
    while (toolCalls < MAX_TOOL_CALLS) {
      if (Date.now() - t0 > JOB_TIMEOUT_MS) {
        await addStep('Timeout', 'Job encerrado por timeout', 'timeout');
        break;
      }


      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:       'llama3-70b-8192',
          temperature: 0.3,
          max_tokens:  2500,
          messages:    [{ role: 'system', content: systemPrompt }, ...messages]
        })
      });


      if (!res.ok) throw new Error(`Groq: ${await res.text()}`);
      const data  = await res.json();
      const reply = data.choices[0].message.content;


      messages.push({ role: 'assistant', content: reply });


      // Verifica se há tool call
      const toolCall = parseToolCall(reply);


      if (!toolCall) {
        // Sem tool call — agente terminou
        await addStep('Resposta final', reply.slice(0, 500));
        await jobRef.update({
          status:    'done',
          result:    reply,
          steps,
          totalMs:   Date.now() - t0,
          toolCalls,
          doneAt:    now(),
          updatedAt: now()
        });
        return;
      }


      // Executa a ferramenta
      toolCalls++;
      await addStep(`Tool: ${toolCall.tool}`, { args: toolCall.args });


      try {
        const toolResult = await executeTool(toolCall.tool, toolCall.args || {}, tenantId, userId);
        const resultStr  = JSON.stringify(toolResult).slice(0, 1500);
        messages.push({ role: 'user', content: `<tool_result>\n${resultStr}\n</tool_result>` });
        await addStep(`Resultado: ${toolCall.tool}`, toolResult);
      } catch (e) {
        messages.push({ role: 'user', content: `<tool_result>\n{"error": "${e.message}"}\n</tool_result>` });
        await addStep(`Erro: ${toolCall.tool}`, { error: e.message }, 'error');
      }
    }


    // Máximo de tool calls atingido — gera síntese
    const lastMsg = messages[messages.length - 1];
    const finalResult = lastMsg.role === 'assistant' ? lastMsg.content : 'Tarefa concluída após múltiplas operações.';


    await jobRef.update({
      status:    'done',
      result:    finalResult,
      steps,
      totalMs:   Date.now() - t0,
      toolCalls,
      doneAt:    now(),
      updatedAt: now()
    });


  } catch (err) {
    await jobRef.update({
      status:    'error',
      error:     err.message,
      steps,
      totalMs:   Date.now() - t0,
      toolCalls,
      updatedAt: now()
    });
    console.error(`[AGENT-LOOP] Job ${jobId} falhou:`, err.message);
  }
}


// ── Handler ───────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };


  const guardErr = await guard(event, 'cortex-agent', { skipTenant: true });
  if (guardErr) return guardErr;


  // GET → status do job
  if (event.httpMethod === 'GET') {
    const { jobId } = event.queryStringParameters || {};
    if (!jobId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'jobId obrigatório' }) };


    const snap = await db.collection('cortex_jobs').doc(jobId).get();
    if (!snap.exists) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Job não encontrado' }) };


    return { statusCode: 200, headers, body: JSON.stringify({ jobId, ...snap.data() }) };
  }


  // POST → cria e inicia job
  try {
    const { userId, tenantId = 'nexia', task: rawTask, agentType = 'dev' } = JSON.parse(event.body || '{}');
    if (!userId || !rawTask) throw new Error('userId e task são obrigatórios');


    const task = sanitizePrompt(rawTask);


    const jobRef = await db.collection('cortex_jobs').add({
      userId, tenantId, task: task.slice(0, 2000),
      agentType,
      status:      'running',
      currentStep: 'Iniciando...',
      steps:       [],
      result:      null,
      toolCalls:   0,
      createdAt:   now(),
      updatedAt:   now()
    });


    const jobId = jobRef.id;


    // Fire-and-forget dentro do timeout Netlify
    runAgentLoop(jobId, task, agentType, tenantId, userId).catch(console.error);


    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, jobId, status: 'running', message: 'Use GET /api/agent-run?jobId=' + jobId + ' para acompanhar' })
    };
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: err.message }) };
  }
};






