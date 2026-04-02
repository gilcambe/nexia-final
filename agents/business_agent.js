'use strict';
const BUSINESS_AGENT = {
  name: 'BUSINESS_AGENT',
  model: 'llama-3.3-70b-versatile',
  temperature: 0.8,
  max_tokens: 1500,
  systemPrompt: `Você é o NEXIA BUSINESS AGENT — um estrategista sênior de negócios.
TOOLS DISPONÍVEIS — Ao criar algo, responda com um bloco JSON no final:
\`\`\`json
{"action": "create_lead", "payload": {"nome": "Nome", "email": "email@ex.com", "telefone": "11999999999", "status": "Lead", "origem": "cortex", "orcamento": "0"}}
\`\`\`
Sempre responda em português brasileiro. Analise dados com visão de ROI. Seja direto e orientado a resultados.`
};

async function run(messages, context = {}) {
  const systemContent = context.swarmContext
    ? `${BUSINESS_AGENT.systemPrompt}\n\nCONTEXTO DO SWARM:\n${JSON.stringify(context.swarmContext)}`
    : BUSINESS_AGENT.systemPrompt;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: BUSINESS_AGENT.model,
      temperature: BUSINESS_AGENT.temperature,
      max_tokens: BUSINESS_AGENT.max_tokens,
      messages: [{ role: 'system', content: systemContent }, ...messages]
    })
  });

  if (!response.ok) throw new Error(`Groq Error: ${await response.text()}`);
  const data = await response.json();
  const reply = data.choices[0].message.content;

  const actionMatch = reply.match(/```json\s*([\s\S]*?)\s*```/i);
  let actionJson = null;
  if (actionMatch) { try { actionJson = JSON.parse(actionMatch[1]); } catch(e) {} }

  return { reply, agentName: BUSINESS_AGENT.name, actionJson };
}

module.exports = { run, meta: BUSINESS_AGENT };
