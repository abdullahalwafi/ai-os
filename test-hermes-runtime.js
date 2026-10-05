const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Readable } = require('node:stream');
// Tests inject a read-only DB stub; never mutate the production registry.
const { createHandler } = require('./src/hermes-runtime');
const pool = require('./src/db/mysql');
test.after(() => pool.end());

async function request(db, url, method = 'GET', body, generate) {
  let result;
  const headers = {};
  const req = body === undefined ? Object.assign(Readable.from([]), { url, method }) :
    Object.assign(Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]), { url, method });
  const res = { setHeader(key, value) { headers[key] = value; } };
  const handled = await createHandler(db, generate)(req, res, (res, status, body) => { result = { status, body, headers }; }, () => {});
  return { handled, ...result };
}

test('preserves stable IDs, existing names, roles, brand/HQ and conservative availability', async () => {
  const rows = [
    { agent_key: 'group_ceo', agent_type: 'GROUP_CEO', name: 'Group owner', status: 'active', brand_key: null, brand_name: null },
    { agent_key: 'audio_one_seo', agent_type: 'SEO_AGENT', name: '', status: 'active', brand_key: 'audio_one', brand_name: 'Audio One' },
  ];
  const db = { async query({ sql }) {
    assert.match(sql, /^SELECT /);
    return sql.includes('FROM tasks') ? [[
      { assigned_agent_id: 2, task_key: 'TASK-RUN', task_type: 'TEST', status: 'running', brand_key: 'audio_one', brand_name: 'Audio One' },
    ]] : [[...rows.map((row, index) => ({ id: index + 1, ...row }))]];
  } };
  const response = await request(db, '/hermes-runtime/registry');
  assert.equal(response.status, 200);
  assert.equal(response.body.defaultId, 'group_ceo');
  assert.deepEqual(response.body.agents.map(a => [a.id, a.name, a.role, a.status]), [
    ['group_ceo', 'Group owner', 'Group CEO', 'idle'],
    ['audio_one_seo', 'Audio One — SEO', 'SEO', 'running'],
  ]);
  assert.equal(response.body.agents[0].metadata.brand_key, null);
  assert.equal(response.body.agents[0].metadata.team, 'Digital Musik Group / Headquarters');
  assert.equal(response.body.agents[1].status, 'running');
  assert.equal(response.body.agents[1].metadata.presence_status, 'working');
  assert.equal(response.body.agents[1].metadata.current_task_key, 'TASK-RUN');
  assert.deepEqual(response.body.capabilities, ['agents', 'sessions', 'chat', 'agent-roles']);
});

test('rejects all mutation methods and unknown routes without accessing DB', async () => {
  const db = { query() { throw Error('Must not query'); } };
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    for (const route of ['/registry', '/tasks', '/events/x/process', '/tasks/x/execute']) {
      const r = await request(db, '/hermes-runtime' + route, method);
      assert.equal(r.status, 405);
      assert.equal(r.body.error, 'read_only');
    }
  }
  assert.equal((await request(db, '/hermes-runtime/unknown')).status, 404);
  assert.equal((await request(db, '/agents')).handled, false);
});

test('chat resolves existing agents, keeps role and brand context, and bounds history', async () => {
  const rows = [
    { id: 1, agent_key: 'digital_musik_seo', agent_type: 'SEO_AGENT', name: 'Digital Musik SEO Agent', status: 'active', brand_key: 'digital_musik', brand_name: 'Digital Musik', brand_domain: 'digitalmusik.id' },
    { id: 2, agent_key: 'audio_one_developer', agent_type: 'DEVELOPER_AGENT', name: 'Audio One Developer Agent', status: 'active', brand_key: 'audio_one', brand_name: 'Audio One', brand_domain: 'audioonepro.com' },
    { id: 3, agent_key: 'gg_audio_content', agent_type: 'CONTENT_AGENT', name: 'GG Audio Content Agent', status: 'active', brand_key: 'gg_audio', brand_name: 'GG Audio', brand_domain: 'ggaudio.id' },
  ];
  const db = { async query({ sql }) { return sql.includes('FROM tasks') ? [[]] : [rows]; } };
  const seen = [];
  const generate = async options => {
    seen.push(options);
    return { model: 'openai/gpt-oss-20b', output: options.system.split('\n')[0] };
  };
  for (const [agent, question, expected] of [
    ['digital_musik_seo', 'Siapa kamu dan apa tugasmu?', 'Digital Musik SEO Agent'],
    ['audio_one_developer', 'Analisa kemungkinan penyebab website lambat.', 'Audio One Developer Agent'],
    ['gg_audio_content', 'Buat ide konten speaker.', 'GG Audio Content Agent'],
  ]) {
    const history = Array.from({ length: 13 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn ${index}` }));
    history[12] = { role: 'user', content: question };
    const response = await request(db, '/hermes-runtime/v1/chat/completions', 'POST',
      { role: agent, lane: agent, stream: false, messages: history }, generate);
    assert.equal(response.status, 200);
    assert.match(response.body.choices[0].message.content, new RegExp(expected));
  }
  assert.equal(seen.length, 3);
  assert.ok(seen.every(call => call.messages.length === 12));
  assert.match(seen[0].system, /Digital Musik.*SEO/);
  assert.match(seen[1].system, /Audio One.*Developer/);
  assert.match(seen[2].system, /GG Audio.*Content/);
});

test('action attempts are refused without invoking LLM or writes', async () => {
  const db = { async query({ sql }) {
    return sql.includes('FROM tasks') ? [[]] : [[{ id: 1, agent_key: 'digital_musik_seo', agent_type: 'SEO_AGENT', name: 'Digital Musik SEO Agent', status: 'active', brand_name: 'Digital Musik' }]];
  } };
  const response = await request(db, '/hermes-runtime/v1/chat/completions', 'POST',
    { role: 'digital_musik_seo', lane: 'digital_musik_seo', stream: false, messages: [{ role: 'user', content: 'Publish artikel sekarang.' }] },
    async () => { throw Error('LLM must not run'); });
  assert.equal(response.status, 200);
  assert.match(response.body.choices[0].message.content, /eksekusi belum diaktifkan/);
});

test('unknown agent returns 404 and malformed chat returns 400', async () => {
  const db = { async query({ sql }) { return sql.includes('FROM tasks') ? [[]] : [[]]; } };
  const unknown = await request(db, '/hermes-runtime/v1/chat/completions', 'POST',
    { role: 'unknown_agent', lane: 'unknown_agent', messages: [{ role: 'user', content: 'Halo' }] });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'agent_not_found');
  const malformed = await request(db, '/hermes-runtime/v1/chat/completions', 'POST', '{');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, 'invalid_json');
});

test('health/state use DB availability and never leak errors or secrets', async () => {
  for (const path of ['/health', '/state', '/registry']) {
    const bad = await request({ async query() { throw Error('secret'); } }, '/hermes-runtime' + path);
    assert.equal(bad.status, 503);
    assert.ok(!JSON.stringify(bad).includes('secret'));
  }
  for (const path of ['/health']) {
    const good = await request({ async query({ sql }) { assert.equal(sql, 'SELECT 1'); return [[]]; } }, '/hermes-runtime' + path);
    assert.equal(good.status, 200);
  }
});
