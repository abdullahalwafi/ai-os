const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_POLL_ATTEMPTS = 3;
const POLL_DELAY_MS = 400;

class ArticleApiError extends Error {
  constructor(code, httpStatus = 502) {
    super(code);
    this.code = code;
    this.publicCode = code;
    this.httpStatus = httpStatus;
  }
}

function configuredOptions(options = {}) {
  const baseUrl = options.baseUrl ?? process.env.DIGITAL_MUSIK_ARTICLE_API_BASE_URL;
  const token = options.token ?? process.env.DIGITAL_MUSIK_ARTICLE_API_TOKEN;
  if (typeof baseUrl !== 'string' || !baseUrl.trim() || typeof token !== 'string' || !token.trim()) {
    throw new ArticleApiError('ARTICLE_API_NOT_CONFIGURED', 503);
  }
  let base;
  try { base = new URL(baseUrl); } catch { throw new ArticleApiError('ARTICLE_API_NOT_CONFIGURED', 503); }
  if (base.protocol !== 'https:' && !options.allowInsecure) throw new ArticleApiError('ARTICLE_API_INVALID_REQUEST', 400);
  return { base: new URL(base.toString().replace(/\/$/, '') + '/'), token: token.trim() };
}

function normalizeStatus(status) {
  if (status === 400) return ['ARTICLE_API_INVALID_REQUEST', 400];
  if (status === 401 || status === 403) return ['ARTICLE_API_UNAUTHORIZED', status];
  if (status === 404) return ['ARTICLE_API_REMOTE_ERROR', 502];
  if (status === 409) return ['ARTICLE_API_CONFLICT', 409];
  if (status === 429) return ['ARTICLE_API_RATE_LIMIT', 429];
  return ['ARTICLE_API_REMOTE_ERROR', 502];
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

class DigitalMusikArticleAdapter {
  constructor(options = {}) {
    const config = configuredOptions(options);
    this.base = config.base;
    this.token = config.token;
    this.fetch = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request(path, { method = 'GET', body, idempotencyKey } = {}) {
    const url = new URL(path.replace(/^\//, ''), this.base);
    // The adapter owns a fixed canonical base; callers can only choose a local path.
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) {
      throw new ArticleApiError('ARTICLE_API_INVALID_REQUEST', 400);
    }
    let response;
    try {
      response = await this.fetch(url, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new ArticleApiError('ARTICLE_API_TIMEOUT', 504);
      }
      throw new ArticleApiError('ARTICLE_API_REMOTE_ERROR', 502);
    }
    if (!response.ok) {
      const [code, status] = normalizeStatus(response.status);
      throw new ArticleApiError(code, status);
    }
    let parsed;
    try { parsed = await response.json(); } catch { throw new ArticleApiError('ARTICLE_API_INVALID_JSON', 502); }
    const payload = safeObject(parsed?.data) ?? safeObject(parsed);
    if (!payload) throw new ArticleApiError('ARTICLE_API_INVALID_JSON', 502);
    return payload;
  }

  health() { return this.request('health'); }
  generateDraft(brief, idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      throw new ArticleApiError('ARTICLE_API_INVALID_REQUEST', 400);
    }
    return this.request('generate', { method: 'POST', body: brief, idempotencyKey: idempotencyKey.trim() });
  }
  getStatus(generationId) { return this.request(`status/${encodeURIComponent(String(generationId))}`); }
  getDraft(articleId) { return this.request(`draft/${encodeURIComponent(String(articleId))}`); }

  async generateAndFetchDraft(brief, idempotencyKey) {
    let generation = await this.generateDraft(brief, idempotencyKey);
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS && generation.status === 'generating'; attempt += 1) {
      if (!generation.generation_id) throw new ArticleApiError('ARTICLE_API_INVALID_JSON', 502);
      await sleep(POLL_DELAY_MS);
      generation = await this.getStatus(generation.generation_id);
    }
    if (generation.status === 'generating') throw new ArticleApiError('ARTICLE_API_TIMEOUT', 504);
    if (generation.status && generation.status !== 'draft' && generation.status !== 'completed') {
      throw new ArticleApiError('ARTICLE_API_REMOTE_ERROR', 502);
    }
    const articleId = generation.article_id ?? generation.article?.id;
    if (articleId === undefined || articleId === null) throw new ArticleApiError('ARTICLE_API_INVALID_JSON', 502);
    const draft = await this.getDraft(articleId);
    return { generation, draft };
  }
}

module.exports = { DigitalMusikArticleAdapter, ArticleApiError, normalizeStatus };
