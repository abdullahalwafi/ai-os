// Explicit live test: three small Groq requests; stop on first error, no retries.
const assert = require('assert/strict');
const { generateJSON } = require('./src/llm');
const { analyzeSeo } = require('./src/worker-executor');
(async () => {
  for (const base of ['http://127.0.0.1:3100', 'https://ai.digitalmusik.id']) {
    for (const token of [null, 'wrong']) {
      const response = await fetch(base + '/llm/test', { method: 'POST',
        headers: token ? { Authorization: 'Bearer ' + token } : {}, body: '{}' });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'unauthorized');
    }
    const response = await fetch(base + '/llm/test', { method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.DM_AI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Return exactly the word OK.' }) });
    const body = await response.json();
    if (response.status !== 200) {
      const safeCodes = ['llm_auth_error', 'llm_rate_limited', 'llm_timeout', 'llm_invalid_response', 'llm_provider_error', 'llm_configuration_error'];
      console.error({ target: base, status: response.status, error: safeCodes.includes(body.error) ? body.error : 'test_failed' });
      process.exitCode = 1; return;
    }
    assert.equal(body.success, true); assert.equal(body.output.trim(), 'OK');
    assert.equal(body.provider, 'groq'); assert.equal(body.model, 'openai/gpt-oss-20b');
    console.log({ target: base, status: 200, provider: body.provider, model: body.model, output: 'OK' });
    for (const path of ['/health', '/brands', '/agents', '/tasks', '/events']) {
      const r = await fetch(base + path); assert.equal(r.status, 200);
      const b = await r.json();
      if (path === '/health') { assert.equal(b.status, 'ok'); assert.equal(b.database, 'ok'); }
      if (path === '/brands') assert.equal(b.count, 4);
      if (path === '/agents') assert.equal(b.count, 21);
    }
  }
  const result = await generateJSON({ prompt: 'Return JSON with exactly these fields: {"status":"ok","number":1}', schemaName: 'smoke_test' });
  assert.deepEqual(result.output, { status: 'ok', number: 1 });
  console.log({ json_test: 'PASS', output: { status: 'ok', number: 1 } });
  assert.equal(analyzeSeo({ keyword: 'test', previous_rank: 9, current_rank: 21 }).rank_change, -12);
  console.log('Existing endpoints healthy; deterministic worker unchanged; auth tests PASS');
})().catch(error => {
  const allowed = ['llm_auth_error', 'llm_rate_limited', 'llm_timeout', 'llm_invalid_response', 'llm_provider_error'];
  console.error({ error: allowed.includes(error.code) ? error.code : 'test_failed' }); process.exitCode = 1;
}).finally(() => require('./src/db/mysql').end());
