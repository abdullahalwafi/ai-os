const { complete, LLMError } = require('./provider');

async function generate(options = {}, json = false) {
  const { prompt, system = '', temperature = 0.2, maxTokens = 1024, schemaName = 'response' } = options;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000 ||
      typeof system !== 'string' || system.length > 16000 ||
      !Number.isFinite(temperature) || temperature < 0 || temperature > 2 ||
      !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096 ||
      typeof schemaName !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(schemaName)) {
    throw new LLMError('llm_invalid_input');
  }
  const result = await complete({ prompt, temperature, maxTokens, json,
    system: json ? system + `\nReturn only a valid JSON object for ${schemaName}. No markdown or commentary.` : system });
  if (json) {
    try {
      result.output = JSON.parse(result.output);
      if (!result.output || typeof result.output !== 'object' || Array.isArray(result.output)) throw new Error();
    } catch { throw new LLMError('llm_invalid_response'); }
  }
  return result;
}
module.exports = {
  generateText: options => generate(options, false),
  generateJSON: options => generate(options, true),
  generateChat: async options => {
    const { system = '', messages, temperature = 0.2, maxTokens = 1024 } = options || {};
    if (typeof system !== 'string' || system.length > 16000 || !Array.isArray(messages) ||
        messages.length < 1 || messages.length > 12 || !Number.isFinite(temperature) ||
        temperature < 0 || temperature > 2 || !Number.isInteger(maxTokens) ||
        maxTokens < 1 || maxTokens > 4096) {
      throw new LLMError('llm_invalid_input');
    }
    const normalized = messages.map(message => {
      if (!message || !['user', 'assistant'].includes(message.role) ||
          typeof message.content !== 'string' || !message.content.trim() ||
          message.content.length > 8000) throw new LLMError('llm_invalid_input');
      return { role: message.role, content: message.content.trim() };
    });
    const totalLength = normalized.reduce((sum, message) => sum + message.content.length, 0);
    if (totalLength > 24000) throw new LLMError('llm_invalid_input');
    const result = await complete({
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...normalized],
      temperature, maxTokens, json: false,
    });
    return result;
  },
};
