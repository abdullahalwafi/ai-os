// Explicit integration test: retains two routed/completed tasks and two negative-test tasks.
const assert = require('assert/strict');
const pool = require('./src/db/mysql');
const { analyzeSeo } = require('./src/worker-executor');
const base = 'https://ai.digitalmusik.id';
async function call(path, method = 'GET', body, token = process.env.DM_AI_API_KEY) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json',
    ...(method !== 'GET' && token ? { Authorization: 'Bearer ' + token } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function routed() {
  const e = await call('/events', 'POST', { brand_key: 'digital_musik', event_type: 'seo.keyword_declined',
    source: 'task_010_test', payload: { keyword: 'jasa oem speaker custom', previous_rank: 9, current_rank: 21 } });
  assert.equal(e.status, 201);
  const route = await call('/events/' + e.body.data.event_key + '/process', 'POST');
  assert.equal(route.status, 200);
  return route.body.task.task_key;
}
async function verify(key, from) {
  const [[task]] = await pool.execute('SELECT * FROM tasks WHERE task_key=?', [key]);
  assert.equal(task.status, 'completed'); assert(task.started_at); assert(task.completed_at);
  assert(task.completed_at >= task.started_at);
  const expected = { analysis_version: 1, keyword: 'jasa oem speaker custom', previous_rank: 9, current_rank: 21,
    rank_change: -12, severity: 'high', recommendation: 'manual_review_required' };
  for (const key of ['keyword', 'previous_rank', 'current_rank', 'rank_change', 'severity']) {
    assert.equal(task.result_json[key], expected[key]);
  }
  assert([1, 2].includes(task.result_json.analysis_version));
  assert.equal(task.result_json.llm_status, task.result_json.analysis_version === 2 ? 'success' : 'fallback');
  const [logs] = await pool.execute("SELECT context_json FROM activity_logs WHERE task_id=? AND action='task.status_changed' ORDER BY id", [task.id]);
  const contexts = logs.map(l => l.context_json);
  assert.deepEqual(contexts, [...(from === 'queued' ? [{ from: 'created', to: 'queued' }] : []),
    { from, to: 'running' }, { from: 'running', to: 'completed' }]);
  return task.result_json;
}
(async () => {
  try {
    for (const [drop, severity] of [[-1, 'none'], [0, 'none'], [1, 'low'], [3, 'low'], [4, 'medium'], [10, 'medium'], [11, 'high']]) {
      assert.equal(analyzeSeo({ keyword: 'test', previous_rank: 10, current_rank: 10 + drop }).severity, severity);
    }
    for (const token of [null, 'wrong']) assert.equal((await call('/tasks/missing/execute', 'POST', undefined, token)).status, 401);
    assert.equal((await call('/tasks/missing/execute', 'POST')).status, 404);
    const main = await routed();
    assert.equal((await call('/tasks/' + main + '/execute', 'POST')).status, 200);
    const result = await verify(main, 'created');
    const again = await call('/tasks/' + main + '/execute', 'POST');
    assert.equal(again.status, 409); assert.equal(again.body.error, 'task_not_executable');
    await verify(main, 'created');
    const concurrent = await routed();
    assert.equal((await call('/tasks/' + concurrent + '/status', 'PATCH', { status: 'queued' })).status, 200);
    const attempts = await Promise.all([1, 2].map(() => call('/tasks/' + concurrent + '/execute', 'POST')));
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
    await verify(concurrent, 'queued');
    // Invalid agent, then worker payload failure after running/log writes: both must roll back.
    for (const [agent, error] of [['digital_musik_content', 'invalid_agent_for_task'], ['digital_musik_seo', 'invalid_task_payload']]) {
      const created = await call('/tasks', 'POST', { brand_key: 'digital_musik', agent_key: agent,
        task_type: 'SEO_ANALYSIS', title: 'TASK 010 negative validation test', priority: 'P4', payload: {} });
      assert.equal(created.status, 201);
      const key = created.body.data.task_key;
      const execution = await call('/tasks/' + key + '/execute', 'POST');
      assert.equal(execution.status, 422); assert.equal(execution.body.error, error);
      const [[row]] = await pool.execute('SELECT id,status,started_at,completed_at,result_json FROM tasks WHERE task_key=?', [key]);
      assert.equal(row.status, 'created'); assert.equal(row.started_at, null); assert.equal(row.completed_at, null); assert.equal(row.result_json, null);
      const [[n]] = await pool.execute("SELECT COUNT(*) AS n FROM activity_logs WHERE task_id=? AND action='task.status_changed'", [row.id]);
      assert.equal(n.n, 0);
    }
    for (const path of ['/health', '/brands', '/agents', '/tasks', '/events']) assert.equal((await call(path)).status, 200);
    console.log({ main_task: main, result, duplicate: '409 task_not_executable', concurrent_task: concurrent,
      concurrency: '200 + 409, one result and two worker transition logs',
      rollback_and_invalid_agent: 'PASS', severity_boundaries: 'PASS', existing_endpoints: 'PASS' });
  } catch (e) { console.error({ test: 'FAILED', code: e.code, errno: e.errno }); process.exitCode = 1; }
  finally { await pool.end(); }
})();
