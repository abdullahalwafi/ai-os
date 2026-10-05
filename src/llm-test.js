const { generateText } = require('./llm');
const authorized = require('./auth');
const { readJson } = require('./request-utils');
const { LLMError } = require('./llm/provider');

module.exports = async function handleLLMTest(req, res, sendJson, logError) {
  if (req.method !== 'POST' || req.url.split('?')[0] !== '/llm/test') return false;
  if (!authorized(req)) {
    req.resume();
    sendJson(res, 401, { success: false, error: 'unauthorized' });
    return true;
  }
  try {
    const body = await readJson(req);
    const result = await generateText({ prompt: body.prompt });
    sendJson(res, 200, { success: true, ...result });
  } catch (error) {
    const status = error.httpStatus || (error.code === 'llm_invalid_input' ? 400 : error.code === 'llm_timeout' ? 504 : 502);
    if (!(error instanceof LLMError) && !error.httpStatus) logError('llm_test', error);
    sendJson(res, status, { success: false, error: error.publicCode || (error instanceof LLMError ? error.code : 'internal_server_error') });
  }
  return true;
};
