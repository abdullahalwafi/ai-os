// Offline contract/error tests. No external requests or real credential output.
const assert = require('assert/strict');
const { generateText, generateJSON } = require('./src/llm');
const originalFetch = global.fetch;
const answer = content => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
(async () => {
  try {
    global.fetch = async (url, options) => {
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
      assert(options.signal); assert.equal(options.redirect, 'error');
      return answer('OK');
    };
    assert.equal((await generateText({ prompt: 'test' })).output, 'OK');
    global.fetch = async () => answer('{"status":"ok","number":1}');
    assert.deepEqual((await generateJSON({ prompt: 'test' })).output, { status: 'ok', number: 1 });
    for (const content of ['not JSON', 'null', '[]']) {
      global.fetch = async () => answer(content);
      await assert.rejects(generateJSON({ prompt: 'test' }), { code: 'llm_invalid_response' });
    }
    for (const [status, code] of [[401, 'llm_auth_error'], [403, 'llm_auth_error'], [429, 'llm_rate_limited'], [500, 'llm_provider_error']]) {
      global.fetch = async () => new Response('raw error must not escape', { status });
      await assert.rejects(generateText({ prompt: 'test' }), { code, message: code });
    }
    global.fetch = async () => new Response('invalid envelope');
    await assert.rejects(generateText({ prompt: 'test' }), { code: 'llm_invalid_response' });
    const timeout = AbortSignal.timeout;
    try {
      AbortSignal.timeout = () => AbortSignal.abort();
      global.fetch = async () => { throw new Error('raw network error'); };
      await assert.rejects(generateText({ prompt: 'test' }), { code: 'llm_timeout' });
    } finally { AbortSignal.timeout = timeout; }
    await assert.rejects(generateText({ prompt: '' }), { code: 'llm_invalid_input' });
    console.log('PASS offline text/JSON parsing, error normalization, timeout and validation');
  } finally { global.fetch = originalFetch; }
})().catch(() => { console.error('Offline LLM test FAILED'); process.exitCode = 1; });
