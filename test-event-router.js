// Creates three retained test events and two routed tasks. No cleanup deletes.
const assert = require('assert/strict');
const pool = require('./src/db/mysql');
const origin = 'https://ai.digitalmusik.id';
async function call(path, method = 'GET', body, auth = true) {
  const r = await fetch(origin + path, { method, headers: {
    'Content-Type': 'application/json', ...(auth && method !== 'GET' ? { Authorization: 'Bearer ' + process.env.DM_AI_API_KEY } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function event(type = 'seo.keyword_declined') {
  const r = await call('/events', 'POST', { brand_key: 'digital_musik', event_type: type,
    source: 'task_009_test', payload: { keyword: 'jasa oem speaker custom', previous_rank: 9, current_rank: 21 } });
  assert.equal(r.status, 201); assert.equal(r.body.data.status, 'pending');
  return r.body.data.event_key;
}
async function verify(key) {
  const [[e]] = await pool.execute('SELECT status,processed_at FROM events WHERE event_key=?', [key]);
  assert.equal(e.status, 'processed'); assert(e.processed_at);
  const [tasks] = await pool.execute(`SELECT t.*,a.agent_key,a.brand_id AS agent_brand FROM tasks t
    JOIN agents a ON a.id=t.assigned_agent_id WHERE JSON_UNQUOTE(JSON_EXTRACT(t.payload_json,'$.source_event_key'))=?`, [key]);
  assert.equal(tasks.length, 1);
  const t = tasks[0];
  assert.equal(t.agent_key, 'digital_musik_seo'); assert.equal(t.brand_id, t.agent_brand);
  assert.equal(t.task_type, 'SEO_ANALYSIS'); assert.equal(t.priority, 'P1'); assert.equal(t.status, 'created');
  assert.equal(t.title, 'Analyze ranking decline: jasa oem speaker custom');
  assert.deepEqual(t.payload_json, { source_event_key: key, event_type: 'seo.keyword_declined',
    keyword: 'jasa oem speaker custom', previous_rank: 9, current_rank: 21 });
  const [logs] = await pool.execute('SELECT action FROM activity_logs WHERE task_id=? ORDER BY id', [t.id]);
  assert.deepEqual(logs.map(l => l.action), ['task.created', 'event.processed']);
  return t.task_key;
}
(async () => {
  try {
    for (const path of ['/events/missing/process', '/tasks', '/events']) {
      assert.equal((await call(path, 'POST', {}, false)).status, 401);
    }
    const wrong = await fetch(origin + '/events/missing/process', { method: 'POST', headers: { Authorization: 'Bearer wrong' } });
    assert.equal(wrong.status, 401);
    assert.equal((await call('/events/missing/process', 'POST')).status, 404);
    assert.equal((await call('/tasks', 'POST', {})).status, 400);
    const key = await event();
    const processed = await call('/events/' + key + '/process', 'POST');
    assert.equal(processed.status, 200);
    const taskKey = await verify(key);
    const duplicate = await call('/events/' + key + '/process', 'POST');
    assert.equal(duplicate.status, 409); assert.equal(duplicate.body.error, 'event_already_finalized');
    await verify(key);
    const concurrentKey = await event();
    const results = await Promise.all([1, 2].map(() => call('/events/' + concurrentKey + '/process', 'POST')));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const concurrentTask = await verify(concurrentKey);
    const unsupportedKey = await event('website.error_detected');
    const unsupported = await call('/events/' + unsupportedKey + '/process', 'POST');
    assert.equal(unsupported.status, 422); assert.equal(unsupported.body.error, 'unsupported_event_type');
    const unsupportedDetail = (await call('/events/' + unsupportedKey)).body.data;
    assert.equal(unsupportedDetail.status, 'pending'); assert.equal(unsupportedDetail.processed_at, null);
    const [[count]] = await pool.execute("SELECT COUNT(*) AS n FROM tasks WHERE JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.source_event_key'))=?", [unsupportedKey]);
    assert.equal(count.n, 0);
    for (const path of ['/health', '/brands', '/agents', '/tasks', '/events']) assert.equal((await call(path)).status, 200);
    console.log({ event: key, task: taskKey, duplicate: '409; still one task',
      concurrent_event: concurrentKey, concurrent_task: concurrentTask, concurrency: '200 + 409; one task',
      unsupported_event: unsupportedKey, unsupported: '422; pending; zero tasks', router_logs_per_task: 2,
      existing_endpoints_and_auth: 'PASS' });
  } catch (e) { console.error({ test: 'FAILED', code: e.code, errno: e.errno }); process.exitCode = 1; }
  finally { await pool.end(); }
})();
