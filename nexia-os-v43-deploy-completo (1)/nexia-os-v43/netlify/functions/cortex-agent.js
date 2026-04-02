'use strict';
// NEXIA OS — CORTEX AGENT v9.0 CORRIGIDO
function parseToolCall(text) {
  const match = text.match(/<tool_call>[\s\S]*?<\/tool_call>/i);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}
async function runAgentLoop(jobId, task, agentType, tenantId, userId) {
  let toolCalls = 0;
  const messages = [{ role: 'user', content: task }];
  while (toolCalls < MAX_TOOL_CALLS) {
    const res = await callGroq(messages);
    const reply = res.choices[0].message.content;
    messages.push({ role: 'assistant', content: reply });
    const toolCall = parseToolCall(reply);
    if (!toolCall) break;
    toolCalls++;
    const toolResult = await executeTool(toolCall.tool, toolCall.args, tenantId, userId);
    messages.push({ role: 'user', content: `<tool_result>\n${JSON.stringify(toolResult)}\n</tool_result>` });
  }
}