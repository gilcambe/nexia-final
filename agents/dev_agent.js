'use strict';
const DEV_AGENT = {
  name: 'DEV_AGENT',
  model: 'llama-3.3-70b-versatile',
  temperature: 0.4,
  max_tokens: 2048,
  systemPrompt: `Você é o NEXIA DEV AGENT — um Principal Engineer.
TOOLS DISPONÍVEIS — Ao criar algo, inclua um bloco JSON ao final:
\`\`\`json
{"action": "create_task", "payload": {"titulo": "Título", "descricao": "Desc", "responsavel": "dev-team", "prioridade": "alta"}}
\`\`\`
Responda sempre em português. Seja preciso e foque em segurança, performance e arquitetura.`
};

async function run(messages, context = {}) {
  const systemContent = DEV_AGENT.systemPrompt;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: DEV_AGENT.model,
      temperature: DEV_AGENT.temperature,
      max_tokens: DEV_AGENT.max_tokens,
      messages: [{ role: 'system', content: systemContent }, ...messages]
    })
  });

  if (!response.ok) throw new Error(`Groq Error: ${await response.text()}`);
  const data = await response.json();
  const reply = data.choices[0].message.content;

  const actionMatch = reply.match(/```json\s*([\s\S]*?)\s*```/i);
  let actionJson = null;
  if (actionMatch) { try { actionJson = JSON.parse(actionMatch[1]); } catch(e) {} }

  return { reply, agentName: DEV_AGENT.name, actionJson };
}

module.exports = { run, meta: DEV_AGENT };
