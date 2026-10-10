const { transaction, fail } = require('./request-utils');
const authorized = require('./auth');
const { analyze } = require('./seo-analysis');
const { inspect } = require('./web-qc');
const { DigitalMusikArticleAdapter } = require('./digital-musik-article-adapter');
const { normalizeArticleBrief, stableArticleIdempotencyKey } = require('./article-brief');

function analyzeSeo(payload) {
  if (!payload || typeof payload.keyword !== 'string' || !payload.keyword.trim()) {
    fail(422, 'invalid_task_payload');
  }
  const hasPrevious = Number.isSafeInteger(payload.previous_rank) && payload.previous_rank >= 1;
  const hasCurrent = Number.isSafeInteger(payload.current_rank) && payload.current_rank >= 1;

  if (hasPrevious && hasCurrent) {
    const drop = payload.current_rank - payload.previous_rank;
    return {
      analysis_version: 1,
      keyword: payload.keyword,
      previous_rank: payload.previous_rank,
      current_rank: payload.current_rank,
      rank_change: -drop,
      severity: drop <= 0 ? 'none' : drop <= 3 ? 'low' : drop <= 10 ? 'medium' : 'high',
      recommendation: 'manual_review_required',
    };
  }

  // Reject incomplete rank telemetry (e.g. one provided but invalid/missing)
  if ((payload.previous_rank !== undefined || payload.current_rank !== undefined) && (!hasPrevious || !hasCurrent)) {
    fail(422, 'invalid_task_payload');
  }

  // Pure keyword advisory mode: never fabricate rank, rank_change, or severity
  return {
    analysis_version: 1,
    keyword: payload.keyword,
    previous_rank: null,
    current_rank: null,
    rank_change: null,
    severity: 'unknown',
    recommendation: 'advisory_keyword_analysis',
  };
}

async function logTransition(conn, task, from, to) {
  await conn.execute(`INSERT INTO activity_logs
    (brand_id,agent_id,task_id,level,action,message,context_json)
    VALUES (?,?,?,'INFO','task.status_changed','Worker changed task status',?)`,
  [task.brand_id, task.assigned_agent_id, task.id, JSON.stringify({ from, to })]);
}

function parsePayload(payload) {
  if (typeof payload !== 'string') return payload;
  try { return JSON.parse(payload); } catch { return null; }
}

function validateContentDraftTask(task, agent, brand) {
  if (task.task_type !== 'CONTENT_ARTICLE_DRAFT') return null;
  if (brand.brand_key !== 'digital_musik' || agent.agent_key !== 'digital_musik_content' || agent.agent_type !== 'CONTENT_AGENT') {
    fail(422, 'invalid_agent_for_task');
  }
  return normalizeArticleBrief(parsePayload(task.payload_json));
}

function normalizeArticleDraftResult(generation, draft) {
  const article = draft.article && typeof draft.article === 'object' ? draft.article : draft;
  return {
    generation_id: generation.generation_id ?? null,
    article_id: article.id ?? generation.article_id ?? null,
    status: article.status ?? generation.status ?? 'draft',
    title: article.title ?? null,
    slug: article.slug ?? null,
    word_count: Number.isSafeInteger(article.word_count) ? article.word_count : null,
    meta_title: article.meta_title ?? null,
    meta_description: article.meta_description ?? null,
    suggested_category: article.suggested_category ?? null,
    warnings: Array.isArray(article.warnings) ? article.warnings.filter(item => typeof item === 'string').slice(0, 20) : [],
    published_at: article.published_at ?? null,
    source: 'digital_musik_article_generator',
  };
}

async function markFailed(key, code) {
  try {
    await transaction(async conn => {
      const [[task]] = await conn.execute('SELECT * FROM tasks WHERE task_key=? FOR UPDATE', [key]);
      if (!task || task.status !== 'running') return;
      await conn.execute("UPDATE tasks SET status='failed',completed_at=CURRENT_TIMESTAMP WHERE id=?", [task.id]);
      await logTransition(conn, task, 'running', 'failed');
      await conn.execute(`INSERT INTO activity_logs (brand_id,agent_id,task_id,level,action,message,context_json)
        VALUES (?,?,?,'ERROR','task.analysis','Worker task failed',?)`,
      [task.brand_id, task.assigned_agent_id, task.id, JSON.stringify({ task_key: key, code })]);
    });
  } catch { /* Preserve the original safe error; never expose secondary DB details. */ }
}

async function executeTask(key, generate, expectedAgentId, articleAdapter) {
  const started = Date.now();
  const claim = await transaction(async conn => {
    const [[task]] = await conn.execute('SELECT * FROM tasks WHERE task_key=? FOR UPDATE', [key]);
    if (!task) fail(404, 'task_not_found');
    if (!['created', 'queued'].includes(task.status)) fail(409, 'task_not_executable');
    if (!['SEO_ANALYSIS', 'WEB_QC_CHECK', 'CONTENT_ARTICLE_DRAFT'].includes(task.task_type)) fail(422, 'unsupported_task_type');
    if (task.assigned_agent_id === null) fail(422, 'invalid_agent_for_task');
    if (expectedAgentId !== undefined && task.assigned_agent_id !== expectedAgentId) {
      fail(403, 'agent_ownership_mismatch');
    }
    const [[agent]] = await conn.execute('SELECT agent_key,status,agent_type,brand_id FROM agents WHERE id=? FOR SHARE', [task.assigned_agent_id]);
    const expectedType = task.task_type === 'SEO_ANALYSIS' ? 'SEO_AGENT' :
      task.task_type === 'WEB_QC_CHECK' ? 'WEB_QC_AGENT' : 'CONTENT_AGENT';
    if (!agent || agent.status !== 'active' || agent.agent_type !== expectedType || agent.brand_id !== task.brand_id) {
      fail(422, 'invalid_agent_for_task');
    }
    const facts = task.task_type === 'SEO_ANALYSIS' ? analyzeSeo(parsePayload(task.payload_json)) : null;
    const [[brand]] = await conn.execute('SELECT brand_key,name,domain,website_url FROM brands WHERE id=?', [task.brand_id]);
    if (!brand) fail(422, 'invalid_brand_for_task');
    const articleBrief = validateContentDraftTask(task, agent, brand);
    await conn.execute("UPDATE tasks SET status='running',started_at=COALESCE(started_at,CURRENT_TIMESTAMP) WHERE id=?", [task.id]);
    await logTransition(conn, task, task.status, 'running');
    return { task, agent, brand, facts, articleBrief };
  });
  // Claim is committed first: no database connection/row lock during network I/O.
  // A process crash leaves running for manual review; there is no automatic retry.
  let result;
  try {
    if (claim.task.task_type === 'SEO_ANALYSIS') result = await analyze(claim.facts, claim.brand, generate);
    else if (claim.task.task_type === 'WEB_QC_CHECK') result = await inspect(claim.brand);
    else {
      const adapter = articleAdapter ?? new DigitalMusikArticleAdapter();
      const generated = await adapter.generateAndFetchDraft(claim.articleBrief, stableArticleIdempotencyKey(claim.task.task_key));
      result = normalizeArticleDraftResult(generated.generation, generated.draft);
    }
  } catch (error) {
    const code = error?.publicCode || 'task_execution_failed';
    await markFailed(key, code);
    if (error?.httpStatus) throw error;
    fail(502, 'task_execution_failed');
  }
  return transaction(async conn => {
    const [[task]] = await conn.execute('SELECT * FROM tasks WHERE task_key=? FOR UPDATE', [key]);
    if (!task || task.status !== 'running') fail(409, 'task_not_executable');
    await conn.execute("UPDATE tasks SET result_json=?,status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=?", [JSON.stringify(result), task.id]);
    await logTransition(conn, task, 'running', 'completed');
    await conn.execute(`INSERT INTO activity_logs (brand_id,agent_id,task_id,level,action,message,context_json)
      VALUES (?,?,?,'INFO','task.analysis',?,?)`, [task.brand_id, task.assigned_agent_id, task.id,
      task.task_type === 'SEO_ANALYSIS' ? 'SEO analysis finished' :
        task.task_type === 'WEB_QC_CHECK' ? 'Web QC check finished' : 'Content article draft generated',
      JSON.stringify({ task_key: key, agent_key: claim.agent.agent_key, provider: result.provider ?? null,
        model: result.model ?? null, duration_ms: Date.now() - started, llm_status: result.llm_status })]);
    return { success: true, task_key: task.task_key, status: 'completed', result };
  });
}

module.exports = async function handleWorker(req, res, sendJson, logError) {
  const match = req.url.split('?')[0].match(/^\/tasks\/([^/]+)\/execute$/);
  if (req.method !== 'POST' || !match) return false;
  req.resume();
  if (!authorized(req)) {
    sendJson(res, 401, { success: false, error: 'unauthorized' });
    return true;
  }
  try { sendJson(res, 200, await executeTask(match[1])); }
  catch (error) {
    if (!error.httpStatus) logError('worker_executor', error);
    sendJson(res, error.httpStatus || 500, { success: false, error: error.publicCode || 'internal_server_error' });
  }
  return true;
};

module.exports.analyzeSeo = analyzeSeo;
module.exports.executeTask = executeTask;
module.exports.normalizeArticleDraftResult = normalizeArticleDraftResult;
module.exports.validateContentDraftTask = validateContentDraftTask;
