// IJF AI's only contact with OpenAI: one chat completion (with tools), streamed. Called only from this
// server: the key never reaches a browser. The model is a setting (OPENAI_MODEL), so it can be changed
// without touching the code. Tests pass their own `complete` instead (createApp({ ai })).

const URL = 'https://api.openai.com/v1/chat/completions';
const TIMEOUT_MS = 45_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A problem the person is told about in plain words (status: what /api/chat answers).
export class AiError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

// complete({ messages, tools, toolChoice, onText, signal }) -> { content, toolCalls: [{ id, name, arguments }], usage }
// onText(delta) gets the answer's text as it arrives. One retry when OpenAI is busy or can't be reached
// (only before anything has arrived, so nothing is shown twice).
export function createOpenAi({ apiKey, model, reasoningEffort = '' }, fetchImpl = fetch) {
  return async function complete({ messages, tools, toolChoice = 'auto', onText = () => {}, signal }) {
    const body = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 4000,
      ...(tools?.length ? { tools, tool_choice: toolChoice } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    };
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        const timeout = AbortSignal.timeout(TIMEOUT_MS);
        res = await fetchImpl(URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt < 2) {
          await sleep(1500);
          continue;
        }
        throw new AiError("IJF AI can't be reached right now. Please try again in a minute.");
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < 2) {
          await sleep(2500);
          continue;
        }
        throw new AiError('IJF AI is busy right now. Please try again in a minute.');
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        const message = String(detail?.error?.message ?? '');
        // A model that doesn't take reasoning_effort: once more without it.
        if (attempt < 2 && body.reasoning_effort && /reasoning_effort/i.test(message)) {
          delete body.reasoning_effort;
          continue;
        }
        console.error(`OpenAI refused (${res.status}): ${message.replace(/sk-[A-Za-z0-9_-]+/g, 'sk-…')}`);
        if (res.status === 401) throw new AiError("IJF AI isn't set up correctly: OpenAI refused the key (OPEN_AI_API_KEY).", 503);
        if (res.status === 404) throw new AiError(`IJF AI isn't set up correctly: the model "${model}" isn't available (OPENAI_MODEL).`, 503);
        throw new AiError("IJF AI couldn't answer that. Please try again.", 502);
      }
      return readStream(res.body, onText);
    }
  };
}

// The streamed answer: text as it arrives, tool calls put together from their pieces, and the token count.
async function readStream(stream, onText) {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const calls = [];
  let usage = null;
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.usage) usage = event.usage;
      const delta = event.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        onText(delta.content);
      }
      for (const part of delta.tool_calls ?? []) {
        const call = (calls[part.index] ??= { id: '', name: '', arguments: '' });
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.arguments += part.function.arguments;
      }
    }
  }
  return {
    content,
    toolCalls: calls.filter(Boolean),
    usage: { prompt: usage?.prompt_tokens ?? 0, completion: usage?.completion_tokens ?? 0 },
  };
}
