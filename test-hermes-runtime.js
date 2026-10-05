const assert = require('node:assert/strict');
const { test } = require('node:test');
// Tests inject a read-only DB stub; never mutate the production registry.
const { createHandler } = require('./src/hermes-runtime');
const pool = require('./src/db/mysql');
test.after(() => pool.end());

async function request(db, url, method = 'GET') {
  let result;
  const headers = {};
  const req = { url, method, resume() {} };
  const res = { setHeader(key, value) { headers[key] = value; } };
  const handled = await createHandler(db)(req, res, (res, status, body) => { result = { status, body, headers }; }, () => {});
  return { handled, ...result };
}

test('preserves stable IDs, existing names, roles, brand/HQ and conservative availability', async () => {
  const rows = [
    { agent_key: 'group_ceo', agent_type: 'GROUP_CEO', name: 'Group owner', status: 'active', brand_key: null, brand_name: null },
    { agent_key: 'audio_one_seo', agent_type: 'SEO_AGENT', name: '', status: 'inactive', brand_key: 'audio_one', brand_name: 'Audio One' },
  ];
  const db = { async query({ sql }) { assert.match(sql, /^SELECT /); return [rows]; } };
  const response = await request(db, '/hermes-runtime/registry');
  assert.equal(response.status, 200);
  assert.equal(response.body.defaultId, 'group_ceo');
  assert.deepEqual(response.body.agents.map(a => [a.id, a.name, a.role, a.status]), [
    ['group_ceo', 'Group owner', 'Group CEO', 'idle'],
    ['audio_one_seo', 'Audio One — SEO', 'SEO', 'offline'],
  ]);
  assert.equal(response.body.agents[0].metadata.brand_key, null);
  assert.equal(response.body.agents[0].metadata.team, 'Digital Musik Group / Headquarters');
  assert.deepEqual(response.body.capabilities, ['agents', 'agent-roles']);
});

test('rejects all mutation methods and unknown routes without accessing DB', async () => {
  const db = { query() { throw Error('Must not query'); } };
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    for (const route of ['/registry', '/tasks', '/events/x/process', '/tasks/x/execute', '/v1/chat/completions']) {
      const r = await request(db, '/hermes-runtime' + route, method);
      assert.equal(r.status, 405);
      assert.equal(r.body.error, 'read_only');
    }
  }
  assert.equal((await request(db, '/hermes-runtime/unknown')).status, 404);
  assert.equal((await request(db, '/agents')).handled, false);
});

test('health/state use DB availability and never leak errors or secrets', async () => {
  for (const path of ['/health', '/state', '/registry']) {
    const bad = await request({ async query() { throw Error('secret'); } }, '/hermes-runtime' + path);
    assert.equal(bad.status, 503);
    assert.ok(!JSON.stringify(bad).includes('secret'));
  }
  for (const path of ['/health', '/state']) {
    const good = await request({ async query({ sql }) { assert.equal(sql, 'SELECT 1'); return [[]]; } }, '/hermes-runtime' + path);
    assert.equal(good.status, 200);
  }
});
