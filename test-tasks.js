// Explicit integration test: creates and retains ONE completed task plus audit logs.
// Run only when intentionally testing a running local dm-ai-os instance.
const assert = require('assert/strict');
const pool = require('./src/db/mysql');

async function request(path, method = 'GET', body, expected = 200) {
  const response = await fetch('http://127.0.0.1:3100' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { Authorization: 'Bearer ' + process.env.DM_AI_API_KEY }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, expected);
  return response.json();
}

(async () => {
  try {
    const input = { brand_key: 'digital_musik', agent_key: 'digital_musik_seo',
      task_type: 'SEO_ANALYSIS', title: 'TASK 005 - Analyze SEO performance',
      description: 'Basic task engine lifecycle verification', priority: 'P2', payload: {} };
    for (const key of ['brand_key', 'agent_key', 'task_type', 'title', 'priority']) {
      const invalid = { ...input }; delete invalid[key];
      await request('/tasks', 'POST', invalid, 400);
    }
    await request('/tasks', 'POST', { ...input, agent_key: 'audio_one_seo' }, 400);
    await request('/tasks', 'POST', { ...input, priority: 'P9' }, 400);
    await request('/tasks', 'POST', { ...input, brand_key: 'missing' }, 400);
    await request('/tasks', 'POST', { ...input, agent_key: 'missing' }, 400);
    for (const [raw, status] of [['{', 400], ['x'.repeat(256 * 1024 + 1), 413]]) {
      const response = await fetch('http://127.0.0.1:3100/tasks', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.DM_AI_API_KEY }, body: raw });
      assert.equal(response.status, status);
    }
    await request('/tasks/TASK-missing', 'GET', undefined, 404);
    await request('/tasks/TASK-missing/status', 'PATCH', { status: 'queued' }, 404);
    const created = (await request('/tasks', 'POST', input, 201)).data;
    console.log('Created test task:', created.task_key);
    assert.equal(created.status, 'created');
    assert.equal(created.started_at, null);
    assert.equal(created.completed_at, null);
    const path = '/tasks/' + created.task_key;
    await request(path + '/status', 'PATCH', { status: 'completed' }, 409);
    await request(path + '/status', 'PATCH', { status: 'invalid' }, 400);
    const queued = (await request(path + '/status', 'PATCH', { status: 'queued' })).data;
    assert.equal(queued.status, 'queued');
    assert.equal(queued.started_at, null);
    // Concurrent attempts must produce one change and exactly one audit record.
    const attempts = await Promise.all([1, 2].map(() => fetch('http://127.0.0.1:3100' + path + '/status', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.DM_AI_API_KEY }, body: JSON.stringify({ status: 'running' }),
    })));
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
    const running = (await request(path)).data;
    assert(running.started_at);
    assert.equal(running.completed_at, null);
    const completed = (await request(path + '/status', 'PATCH', { status: 'completed' })).data;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.started_at, running.started_at);
    assert(completed.completed_at);
    assert(new Date(completed.completed_at) >= new Date(completed.started_at));
    const rejected = await request(path + '/status', 'PATCH', { status: 'running' }, 409);
    assert.equal(rejected.error, 'invalid_status_transition');
    const full = (await request(path)).data;
    assert.equal(full.description, input.description);
    assert.deepEqual(full.payload, {});
    assert.equal(full.result, null);
    const list = await request('/tasks?brand=digital_musik&status=completed&agent=digital_musik_seo');
    assert(list.data.some(t => t.task_key === created.task_key));
    assert(list.data.every(t => t.brand_key === 'digital_musik' && t.status === 'completed' && t.agent_key === 'digital_musik_seo'));
    assert(list.data.every(t => !('payload' in t) && !('payload_json' in t) && !('result_json' in t)));
    await request('/tasks');
    assert.equal((await request('/tasks?brand=' + encodeURIComponent("' OR 1=1 --"))).count, 0);
    const [logs] = await pool.execute(`SELECT l.action,l.context_json FROM activity_logs l
      JOIN tasks t ON t.id=l.task_id WHERE t.task_key=? ORDER BY l.id`, [created.task_key]);
    assert.deepEqual(logs.map(l => l.action), ['task.created', 'task.status_changed', 'task.status_changed', 'task.status_changed']);
    assert.deepEqual(logs.slice(1).map(l => l.context_json), [
      { from: 'created', to: 'queued' }, { from: 'queued', to: 'running' }, { from: 'running', to: 'completed' },
    ]);
    const health = await request('/health');
    assert.equal(health.status, 'ok'); assert.equal(health.database, 'ok');
    assert.equal((await request('/brands')).count, 4);
    assert.equal((await request('/agents')).count, 21);
    console.log(JSON.stringify({ task_key: full.task_key, status: full.status,
      started_at: full.started_at, completed_at: full.completed_at, activity_logs: logs.length,
      terminal_transition: '409 invalid_status_transition', existing_endpoints: 'OK',
      validation_body_limit_filters_concurrency: 'PASS' }, null, 2));
  } catch (error) {
    console.error({ test: 'FAILED', code: error.code, errno: error.errno });
    process.exitCode = 1;
  } finally { await pool.end(); }
})();
