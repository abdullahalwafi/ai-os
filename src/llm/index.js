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
};
