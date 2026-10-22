// One question to IJF AI: the question (contacts hidden) and the chat so far go to the AI with the tools;
// the tools it asks for run here; this repeats until it answers (at most MAX_ROUNDS look-ups). The answer
// streams to the person with the real contacts put back. Nothing with a phone number or an email in it
// is ever sent to OpenAI (privacy.js), checked once more right before each call.

import { createRevealer, hideContacts, protect, reveal } from './privacy.js';
import { systemPrompt } from './prompt.js';
import { runTool, TOOL_STATUS, TOOLS } from './tools.js';

const MAX_ROUNDS = 6;
const HISTORY = 12; // earlier messages sent with a question

// A past message as the AI sees it: the question with stand-ins, its own answer, and what happened to
// any change it proposed.
function historyOf(message) {
  if (message.role === 'user') return { role: 'user', content: message.modelContent ?? message.content };
  const outcome = (message.actions ?? [])
    .map((a) => `\n[Proposed change: ${a.summaryForModel ?? a.summary} -> ${a.status === 'done' ? 'confirmed and saved' : a.status === 'cancelled' ? 'cancelled by the person' : a.status === 'failed' ? `failed: ${a.error}` : 'waiting for Confirm'}]`)
    .join('');
  return { role: 'assistant', content: `${message.modelContent ?? message.content}${outcome}` };
}

// emit(event, data): 'status' (a tool is running), 'text' (answer so far), 'card', 'action'.
// Returns what to store: { content, modelContent, cards, actions, tools, usage }.
export async function runChat({ complete, chat, question, context, person, emit, signal, request }) {
  const secrets = chat.secrets ?? {};
  const modelQuestion = request ?? hideContacts(question, secrets);
  const ctx = { person, secrets, context, cards: [], actions: [], tools: [] };
  const messages = [
    { role: 'system', content: systemPrompt({ person: { ...person, name: hideContacts(person.name || '', secrets) }, context }) },
    ...chat.messages.slice(-HISTORY).map(historyOf),
    { role: 'user', content: modelQuestion },
  ];
  const usage = { prompt: 0, completion: 0 };
  const revealer = createRevealer(secrets);
  let answer = '';

  for (let round = 1; ; round++) {
    const last = round > MAX_ROUNDS;
    // The last check: every text going out without a phone number or email in it.
    const safe = messages.map((m) => (typeof m.content === 'string' ? { ...m, content: hideContacts(m.content, secrets) } : m));
    const result = await complete({
      messages: safe,
      tools: TOOLS,
      toolChoice: last ? 'none' : 'auto',
      signal,
      onText: (delta) => {
        answer += delta;
        const shown = revealer.push(delta);
        if (shown) emit('text', shown);
      },
    });
    usage.prompt += result.usage.prompt;
    usage.completion += result.usage.completion;
    if (!result.toolCalls.length || last) break;

    messages.push({
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
    });
    for (const call of result.toolCalls) {
      emit('status', TOOL_STATUS[call.name] ?? 'Looking it up');
      const cards = ctx.cards.length;
      const actions = ctx.actions.length;
      const output = await runTool(call, ctx);
      for (const card of ctx.cards.slice(cards)) emit('card', card);
      for (const action of ctx.actions.slice(actions)) emit('action', action);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(protect(output, secrets)) });
    }
  }
  const rest = revealer.flush();
  if (rest) emit('text', rest);
  return {
    content: reveal(answer, secrets).trim(),
    modelContent: answer.trim(),
    modelQuestion,
    cards: ctx.cards,
    actions: ctx.actions.map((a) => ({ ...a, summaryForModel: hideContacts(a.summary, secrets) })),
    tools: ctx.tools,
    usage,
    secrets,
  };
}
