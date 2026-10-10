const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DigitalMusikArticleAdapter, ArticleApiError } = require('./src/digital-musik-article-adapter');
const { normalizeArticleBrief, stableArticleIdempotencyKey } = require('./src/article-brief');
const { validateContentDraftTask, normalizeArticleDraftResult } = require('./src/worker-executor');
const pool = require('./src/db/mysql');

test.after(() => pool.end());

const configured = (fetchImpl) => new DigitalMusikArticleAdapter({
  baseUrl: 'https://digitalmusik.example/api/ai/article-generator', token: 'test-token', fetchImpl, timeoutMs: 20,
});
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('article adapter parses health, generates once with a stable idempotency key, then fetches draft', async () => {
  const calls = [];
  const adapter = configured(async (url, options) => {
    calls.push({ path: new URL(url).pathname, headers: options.headers, body: options.body });
    if (String(url).endsWith('/health')) return json(200, { ok: true });
    if (String(url).endsWith('/generate')) return json(200, { generation_id: 'gen-1', article_id: 262, status: 'draft' });
    return json(200, { id: 262, status: 'draft', title: 'OEM Speaker', word_count: 1200, published_at: null });
  });
  assert.deepEqual(await adapter.health(), { ok: true });
  const result = await adapter.generateAndFetchDraft({ topic: 'OEM speaker' }, 'dm-ai-os:TASK-1');
  assert.equal(result.generation.generation_id, 'gen-1');
  assert.equal(result.draft.id, 262);
  assert.equal(calls[1].headers['Idempotency-Key'], 'dm-ai-os:TASK-1');
  assert.equal(calls[2].path, '/api/ai/article-generator/draft/262');
  assert.equal(calls.some(call => /publish/i.test(call.path)), false);
});

for (const [status, code] of [[400, 'ARTICLE_API_INVALID_REQUEST'], [401, 'ARTICLE_API_UNAUTHORIZED'], [409, 'ARTICLE_API_CONFLICT'], [429, 'ARTICLE_API_RATE_LIMIT'], [500, 'ARTICLE_API_REMOTE_ERROR']]) {
  test(`article adapter normalizes HTTP ${status}`, async () => {
    const adapter = configured(async () => json(status, { error: 'remote detail is not exposed' }));
    await assert.rejects(() => adapter.health(), error => error instanceof ArticleApiError && error.code === code);
  });
}

test('article adapter normalizes invalid JSON and timeout', async () => {
  const invalid = configured(async () => new Response('not json', { status: 200 }));
  await assert.rejects(() => invalid.health(), error => error.code === 'ARTICLE_API_INVALID_JSON');
  const timeout = configured(async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  await assert.rejects(() => timeout.health(), error => error.code === 'ARTICLE_API_TIMEOUT');
});

test('article briefs require supplied topic or keyword and stable task-based idempotency', () => {
  assert.deepEqual(normalizeArticleBrief({ primary_keyword: 'jasa produksi speaker OEM' }), {
    topic: 'jasa produksi speaker OEM', secondary_keywords: [], required_sections: [], required_facts: [], forbidden_claims: [], internal_link_candidates: [], primary_keyword: 'jasa produksi speaker OEM', target_length: 1200,
  });
  assert.throws(() => normalizeArticleBrief({}), /article_topic_or_keyword_required/);
  assert.equal(stableArticleIdempotencyKey('TASK-123'), 'dm-ai-os:TASK-123');
  assert.equal(stableArticleIdempotencyKey('TASK-123'), 'dm-ai-os:TASK-123');
});

test('CONTENT_ARTICLE_DRAFT ownership is limited to Mira and normalized results remain draft-only', () => {
  const task = { task_type: 'CONTENT_ARTICLE_DRAFT', payload_json: { topic: 'OEM speaker' } };
  const mira = { agent_key: 'digital_musik_content', agent_type: 'CONTENT_AGENT' };
  assert.equal(validateContentDraftTask(task, mira, { brand_key: 'digital_musik' }).topic, 'OEM speaker');
  assert.throws(() => validateContentDraftTask(task, { agent_key: 'audio_one_content', agent_type: 'CONTENT_AGENT' }, { brand_key: 'audio_one' }), /invalid_agent_for_task/);
  assert.deepEqual(normalizeArticleDraftResult({ generation_id: 'gen-1', article_id: 262, status: 'draft' }, {
    id: 262, status: 'draft', title: 'OEM Speaker', word_count: 1200,
  }), {
    generation_id: 'gen-1', article_id: 262, status: 'draft', title: 'OEM Speaker', slug: null,
    word_count: 1200, meta_title: null, meta_description: null, suggested_category: null,
    warnings: [], published_at: null, source: 'digital_musik_article_generator',
  });
});
