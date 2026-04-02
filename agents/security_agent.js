'use strict';
const SECURITY_AGENT = {
  name: 'SECURITY_AGENT',
  model: 'llama-3.3-70b-versatile',
  temperature: 0.2,
  max_tokens: 2048,
  systemPrompt: `Você é o NEXIA SECURITY AGENT — um CISO virtual.
TOOLS DISPONÍVEIS — Ao registrar algo, inclua um bloco JSON ao final:
\`\`\`json
{"action": "create_security_alert", "payload": {"titulo": "Alerta", "severidade": "alta", "descricao": "Desc"}}
\`\`\`
Responda em português brasileiro. NUNCA minimize riscos de segurança.`
};

async function run(messages, context = {}) {
  const systemContent = SECURITY_AGENT.systemPrompt;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: SECURITY_AGENT.model,
      temperature: SECURITY_AGENT.temperature,
      max_tokens: SECURITY_AGENT.max_tokens,
      messages: [{ role: 'system', content: systemContent }, ...messages]
    })
  });

  if (!response.ok) throw new Error(`Groq Error: ${await response.text()}`);
  const data = await response.json();
  const reply = data.choices[0].message.content;

  const actionMatch = reply.match(/```json\s*([\s\S]*?)\s*```/i);
  let actionJson = null;
  if (actionMatch) { try { actionJson = JSON.parse(actionMatch[1]); } catch(e) {} }

  return { reply, agentName: SECURITY_AGENT.name, actionJson };
}

module.exports = { run, meta: SECURITY_AGENT };
