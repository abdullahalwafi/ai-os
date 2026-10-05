// Explicit integration test: retains one processed event and its two audit logs.
const assert = require('assert/strict');
const pool = require('./src/db/mysql');
const base = 'http://127.0.0.1:3100';
const token = 'Bearer ' + process.env.DM_AI_API_KEY;
async function request(path, method = 'GET', body, expected = 200, auth = token, origin = base) {
  const response = await fetch(origin + path, { method,
    headers: { 'Content-Type': 'application/json', ...(method === 'GET' || auth === null ? {} : { Authorization: auth }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, expected);
  return response.json();
}
(async () => {
  try {
    for (const origin of [base, 'https://ai.digitalmusik.id']) {
      for (const auth of [null, 'Bearer wrong']) {
        for (const resource of ['events', 'tasks']) {
          assert.equal((await request('/' + resource, 'POST', {}, 401, auth, origin)).error, 'unauthorized');
          await request('/' + resource + '/missing/status', 'PATCH', { status: 'processed' }, 401, auth, origin);
        }
      }
      // A valid token reaches task validation without creating extra tasks.
      await request('/tasks', 'POST', {}, 400, token, origin);
      await request('/tasks/missing/status', 'PATCH', { status: 'queued' }, 404, token, origin);
    }
    const input = { brand_key: 'digital_musik', event_type: 'seo.keyword_declined', source: 'manual_test',
      payload: { keyword: 'jasa oem speaker', previous_rank: 8, current_rank: 17 } };
    for (const bad of [{ ...input, event_type: '' }, { ...input, source: '' }, { ...input, brand_key: 'missing' }]) {
      await request('/events', 'POST', bad, 400);
    }
    for (const [body, expected] of [['{', 400], ['x'.repeat(262145), 413]]) {
      const response = await fetch(base + '/events', { method: 'POST', headers: { Authorization: token }, body });
      assert.equal(response.status, expected);
    }
    assert.equal((await request('/events/missing', 'GET', undefined, 404)).error, 'event_not_found');
    const event = (await request('/events', 'POST', input, 201)).data;
    console.log('Created event:', event.event_key);
    const path = '/events/' + event.event_key;
    assert.equal(event.status, 'pending'); assert.equal(event.processed_at, null);
    const listed = await request('/events?brand=digital_musik&status=pending&type=seo.keyword_declined');
    assert(listed.data.some(e => e.event_key === event.event_key));
    assert(listed.data.every(e => !('payload' in e) && e.status === 'pending' && e.brand_key === 'digital_musik'));
    const detail = (await request(path)).data;
    assert.deepEqual(detail.payload, input.payload);
    await request(path + '/status', 'PATCH', { status: 'pending' }, 409);
    const processed = (await request(path + '/status', 'PATCH', { status: 'processed' })).data;
    assert.equal(processed.status, 'processed'); assert(processed.processed_at);
    assert(new Date(processed.processed_at) >= new Date(processed.created_at));
    assert.equal((await request(path + '/status', 'PATCH', { status: 'failed' }, 409)).error, 'invalid_status_transition');
    assert.equal((await request(path)).data.processed_at, processed.processed_at);
    const [logs] = await pool.execute(`SELECT action,context_json FROM activity_logs
      WHERE JSON_UNQUOTE(JSON_EXTRACT(context_json,'$.event_key'))=? ORDER BY id`, [event.event_key]);
    assert.deepEqual(logs.map(l => l.action), ['event.created', 'event.status_changed']);
    assert.deepEqual(logs[1].context_json, { event_key: event.event_key, from: 'pending', to: 'processed' });
    for (const origin of [base, 'https://ai.digitalmusik.id']) {
      assert.equal((await request('/health', 'GET', undefined, 200, null, origin)).database, 'ok');
      assert.equal((await request('/brands', 'GET', undefined, 200, null, origin)).count, 4);
      assert.equal((await request('/agents', 'GET', undefined, 200, null, origin)).count, 21);
      await request('/tasks', 'GET', undefined, 200, null, origin);
      await request('/events', 'GET', undefined, 200, null, origin);
      assert.equal((await request(path, 'GET', undefined, 200, null, origin)).data.status, 'processed');
    }
    console.log({ event_key: event.event_key, status: processed.status, processed_at: processed.processed_at,
      activity_logs: logs.length, terminal_transition: '409 invalid_status_transition', existing_endpoints_and_auth: 'PASS' });
  } catch (error) {
    console.error({ test: 'FAILED', code: error.code, errno: error.errno }); process.exitCode = 1;
  } finally { await pool.end(); }
})();
