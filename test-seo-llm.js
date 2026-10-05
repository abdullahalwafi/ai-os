// Explicit integration test: retains two routed tasks (success + injected fallback).
const assert = require('assert/strict');
const pool = require('./src/db/mysql');
const { executeTask, analyzeSeo } = require('./src/worker-executor');
const { analyze } = require('./src/seo-analysis');
const base = 'https://ai.digitalmusik.id';
async function call(path, body, token = process.env.DM_AI_API_KEY) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function routed() {
  const e = await call('/events', { brand_key: 'digital_musik', event_type: 'seo.keyword_declined',
    source: 'task_012_test', payload: { keyword: 'jasa produksi speaker custom', previous_rank: 7, current_rank: 19 } });
  assert.equal(e.status, 201);
  const r = await call('/events/' + e.body.data.event_key + '/process');
  assert.equal(r.status, 200); return r.body.task.task_key;
}
async function verify(key, version) {
  const [[row]] = await pool.execute('SELECT id,status,result_json,started_at,completed_at FROM tasks WHERE task_key=?', [key]);
  assert.equal(row.status, 'completed'); assert(row.started_at); assert(row.completed_at);
  assert.equal(row.result_json.analysis_version, version);
  const [logs] = await pool.execute("SELECT action FROM activity_logs WHERE task_id=? AND action IN ('task.status_changed','task.analysis') ORDER BY id", [row.id]);
  assert.deepEqual(logs.map(l => l.action), ['task.status_changed', 'task.status_changed', 'task.analysis']);
  return row.result_json;
}
(async () => {
  try {
    const facts = analyzeSeo({ keyword: 'test', previous_rank: 7, current_rank: 19 });
    const good = { ...facts, analysis_version: 2, summary: 'Ranking turun dari 7 ke 19.',
      possible_causes: ['Hypothesis (needs verification): perubahan relevansi'],
      recommended_actions: [{ action: 'Periksa relevansi halaman', priority: 'P1' }],
      content_opportunity: { recommended: false, reason: 'Perlu verifikasi' }, confidence: 0.4 };
    for (const bad of [null, { ...good, current_rank: 20 }, { ...good, severity: 'low' },
      { ...good, confidence: 2 }, { ...good, possible_causes: ['Competitor published 3 articles'] },
      { ...good, recommended_actions: [{ action: 'test', priority: 'P9' }] }]) {
      assert.equal((await analyze(facts, {}, async () => ({ output: bad }))).llm_status, 'fallback');
    }
    for (const code of ['llm_timeout', 'llm_rate_limited', 'llm_invalid_response', 'llm_provider_error']) {
      assert.equal((await analyze(facts, {}, async () => { throw new Error(code); })).analysis_version, 1);
    }
    for (const token of [null, 'wrong']) assert.equal((await call('/tasks/missing/execute', undefined, token)).status, 401);
    const key = await routed();
    const attempts = await Promise.all([1, 2].map(() => call('/tasks/' + key + '/execute')));
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
    const success = await verify(key, 2); assert.equal(success.llm_status, 'success');
    assert.equal(success.rank_change, -12); assert.equal(success.severity, 'high');
    console.log(JSON.stringify({ success_task: key, result: success }, null, 2));
    const fallbackKey = await routed();
    await executeTask(fallbackKey, async () => { throw new Error('llm_timeout'); });
    const fallback = await verify(fallbackKey, 1); assert.equal(fallback.llm_status, 'fallback');
    console.log(JSON.stringify({ fallback_task: fallbackKey, result: fallback }, null, 2));
    assert.equal((await call('/tasks/' + key + '/execute')).status, 409);
    for (const path of ['/health', '/brands', '/agents', '/tasks', '/events']) {
      const r = await fetch(base + path); assert.equal(r.status, 200);
      const body = await r.json();
      if (path === '/health') assert.equal(body.database, 'ok');
    }
    const llm = await call('/llm/test', { prompt: 'Return exactly the word OK.' });
    assert.equal(llm.status, 200); assert.equal(llm.body.output.trim(), 'OK');
    console.log('PASS: validation, success, injected fallback, concurrency 200/409, auth, existing endpoints');
  } catch (e) { console.error({ test: 'FAILED', code: e.code, errno: e.errno }); process.exitCode = 1; }
  finally { await pool.end(); }
})();
