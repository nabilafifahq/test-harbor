// One OpenAI-compatible chat client with tool calling.
// Default provider is DeepInfra; Ollama, llama.cpp, vLLM or OpenRouter work by setting LLM_BASE_URL.
// LLM_MODEL may list several models, comma separated: each is tried in order, then the rules reader takes over.
const DEFAULT_BASE_URL = 'https://api.deepinfra.com/v1/openai';
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4-Flash-0731';
// USD per million tokens for the default model on DeepInfra. Set LLM_PRICE_IN / LLM_PRICE_OUT for another model.
const DEFAULT_PRICE = { in: 0.06, out: 0.18 };

export const llmConfigured = () => process.env.LLM_MODE !== 'off' && Boolean(process.env.LLM_API_KEY || process.env.LLM_BASE_URL);
export const llmModels = () => (process.env.LLM_MODEL || DEFAULT_MODEL).split(',').map((s) => s.trim()).filter(Boolean);
export const llmModel = () => (llmConfigured() ? llmModels()[0] : 'rules-only');
const baseUrl = () => (process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');

export function costUsd(model, usage) {
  const custom = process.env.LLM_PRICE_IN && process.env.LLM_PRICE_OUT;
  if (!custom && model !== DEFAULT_MODEL) return null;
  const p = custom ? { in: Number(process.env.LLM_PRICE_IN), out: Number(process.env.LLM_PRICE_OUT) } : DEFAULT_PRICE;
  return ((usage.prompt_tokens || 0) * p.in + (usage.completion_tokens || 0) * p.out) / 1e6;
}

// One chat completion. Retries once on 429 and 5xx. Returns the assistant message, token usage and latency.
export async function chat(model, messages, tools, { timeoutMs = 60000 } = {}) {
  const body = JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0, max_tokens: 2000 });
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const res = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(process.env.LLM_API_KEY ? { authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}) },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ((res.status === 429 || res.status >= 500) && attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
    if (!res.ok) throw new Error(`model HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('model returned no message');
    return { message, usage: data.usage || {}, ms: Date.now() - t0 };
  }
}
