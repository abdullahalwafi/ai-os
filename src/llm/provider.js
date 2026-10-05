const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

class LLMError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function getConfig() {
  const provider = process.env.LLM_PROVIDER;
  const model = process.env.LLM_MODEL;
  if (provider !== 'groq' || !model || !process.env.GROQ_API_KEY) throw new LLMError('llm_configuration_error');
  return { provider, model };
}

async function complete({ system, prompt, messages, temperature, maxTokens, json }) {
  const config = getConfig();
  const signal = AbortSignal.timeout(45000);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model,
        messages: messages || [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
        temperature, max_completion_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new LLMError(response.status === 401 || response.status === 403 ? 'llm_auth_error' :
        response.status === 429 ? 'llm_rate_limited' : 'llm_provider_error');
    }
    const body = await response.json();
    const choice = body?.choices?.[0];
    if (choice?.finish_reason !== 'stop' || typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) {
      throw new LLMError('llm_invalid_response');
    }
    return { ...config, output: choice.message.content };
  } catch (error) {
    if (signal.aborted) throw new LLMError('llm_timeout');
    if (error instanceof LLMError) throw error;
    throw new LLMError(error instanceof SyntaxError ? 'llm_invalid_response' : 'llm_provider_error');
  }
}
module.exports = { complete, getConfig, LLMError };
