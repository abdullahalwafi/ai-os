const { fail } = require('./request-utils');

const TEXT_FIELDS = Object.freeze([
  'topic', 'article_goal', 'target_audience', 'primary_keyword', 'search_intent',
  'tone', 'product_or_service_context', 'cta_instruction',
]);
const ARRAY_FIELDS = Object.freeze([
  'secondary_keywords', 'required_sections', 'required_facts',
  'forbidden_claims', 'internal_link_candidates',
]);

function cleanText(value, max = 500) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return text && text.length <= max ? text : null;
}
function cleanArray(value, maxItems = 20, maxItemLength = 300) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const items = value.map(item => cleanText(item, maxItemLength));
  return items.every(Boolean) ? items : null;
}

function normalizeArticleBrief(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(422, 'invalid_task_payload');
  const brief = {};
  for (const field of TEXT_FIELDS) {
    const value = cleanText(payload[field]);
    if (payload[field] != null && !value) fail(422, 'invalid_task_payload');
    if (value) brief[field] = value;
  }
  for (const field of ARRAY_FIELDS) {
    const value = cleanArray(payload[field]);
    if (!value) fail(422, 'invalid_task_payload');
    brief[field] = value;
  }
  if (payload.target_length != null && (!Number.isSafeInteger(payload.target_length) || payload.target_length < 300 || payload.target_length > 4000)) {
    fail(422, 'invalid_task_payload');
  }
  brief.target_length = payload.target_length ?? 1200;
  if (!brief.topic && !brief.primary_keyword) fail(422, 'article_topic_or_keyword_required');
  // A supplied keyword is a valid topic; this is a normalization, not invented fact.
  if (!brief.topic) brief.topic = brief.primary_keyword;
  return brief;
}

function stableArticleIdempotencyKey(taskKey) {
  if (typeof taskKey !== 'string' || !taskKey.trim()) fail(422, 'invalid_task_payload');
  return `dm-ai-os:${taskKey.trim()}`;
}

module.exports = { normalizeArticleBrief, stableArticleIdempotencyKey };
