// Creates one harmless task per explicit run, retaining it in queued state.
require('dotenv').config({ quiet: true });
const assert = require('assert/strict');
const base = process.argv[2] || 'http://127.0.0.1:3100';
if (!['http://127.0.0.1:3100', 'https://ai.digitalmusik.id'].includes(base)) throw new Error('Unsupported test target');
const key = process.env.DM_AI_API_KEY;
if (!key) throw new Error('Missing API key');

(async () => {
  async function write(path, method, token, body, status) {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { Authorization: token }) },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status);
    const data = await response.json();
    if (status === 401) assert.deepEqual(data, { success: false, error: 'unauthorized' });
    return data;
  }
  for (const token of [undefined, 'Bearer wrong', 'Bearer ' + 'x'.repeat(key.length), 'Basic wrong', 'Bearer']) {
    await write('/tasks', 'POST', token, {}, 401);
    await write('/tasks/TASK-missing/status', 'PATCH', token, { status: 'queued' }, 401);
  }
  const task = (await write('/tasks', 'POST', 'Bearer ' + key, {
    brand_key: 'digital_musik', agent_key: 'digital_musik_seo', task_type: 'AUTH_TEST',
    title: 'TASK 007 authentication verification', priority: 'P4', payload: {},
  }, 201)).data;
  await write('/tasks/' + task.task_key + '/status', 'PATCH', undefined, { status: 'queued' }, 401);
  const updated = await write('/tasks/' + task.task_key + '/status', 'PATCH', 'Bearer ' + key, { status: 'queued' }, 200);
  assert.equal(updated.data.status, 'queued');
  for (const path of ['/health', '/brands', '/agents', '/tasks', '/tasks/' + task.task_key]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    const data = await response.json();
    if (path === '/health') { assert.equal(data.status, 'ok'); assert.equal(data.database, 'ok'); }
    if (path === '/brands') assert.equal(data.count, 4);
    if (path === '/agents') assert.equal(data.count, 21);
  }
  console.log({ base, missing_wrong_malformed: 401, valid_post: 201, valid_patch: 200,
    public_reads: 'PASS', task_key: task.task_key, final_status: 'queued' });
})().catch(() => { console.error('Authentication verification FAILED (details suppressed)'); process.exitCode = 1; });
