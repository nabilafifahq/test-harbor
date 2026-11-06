// One OpenAI-compatible client for Ollama, llama.cpp server, vLLM or OpenRouter.
// LLM_BASE_URL examples: http://localhost:11434/v1 (Ollama), http://localhost:8080/v1 (llama.cpp), https://openrouter.ai/api/v1
export const llmConfigured = () => Boolean(process.env.LLM_BASE_URL && process.env.LLM_MODEL);
export const llmModel = () => (llmConfigured() ? process.env.LLM_MODEL : 'rules-only');

export async function chatJson(system, user) {
  const res = await fetch(`${process.env.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.LLM_API_KEY ? { authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 120000)),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('LLM returned no JSON');
  return JSON.parse(m[0]);
}
