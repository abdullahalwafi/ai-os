const { transaction, fail } = require('./request-utils');
const authorized = require('./auth');
const { analyze } = require('./seo-analysis');
const { inspect } = require('./web-qc');

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

async function executeTask(key, generate, expectedAgentId) {
  const started = Date.now();
  const claim = await transaction(async conn => {
    const [[task]] = await conn.execute('SELECT * FROM tasks WHERE task_key=? FOR UPDATE', [key]);
    if (!task) fail(404, 'task_not_found');
    if (!['created', 'queued'].includes(task.status)) fail(409, 'task_not_executable');
    if (!['SEO_ANALYSIS', 'WEB_QC_CHECK'].includes(task.task_type)) fail(422, 'unsupported_task_type');
    if (task.assigned_agent_id === null) fail(422, 'invalid_agent_for_task');
    if (expectedAgentId !== undefined && task.assigned_agent_id !== expectedAgentId) {
      fail(403, 'agent_ownership_mismatch');
    }
    const [[agent]] = await conn.execute('SELECT agent_key,status,agent_type,brand_id FROM agents WHERE id=? FOR SHARE', [task.assigned_agent_id]);
    const expectedType = task.task_type === 'SEO_ANALYSIS' ? 'SEO_AGENT' : 'WEB_QC_AGENT';
    if (!agent || agent.status !== 'active' || agent.agent_type !== expectedType || agent.brand_id !== task.brand_id) {
      fail(422, 'invalid_agent_for_task');
    }
    const facts = task.task_type === 'SEO_ANALYSIS' ? analyzeSeo(task.payload_json) : null;
    const [[brand]] = await conn.execute('SELECT brand_key,name,domain,website_url FROM brands WHERE id=?', [task.brand_id]);
    await conn.execute("UPDATE tasks SET status='running',started_at=COALESCE(started_at,CURRENT_TIMESTAMP) WHERE id=?", [task.id]);
    await logTransition(conn, task, task.status, 'running');
    return { task, agent, brand, facts };
  });
  // Claim is committed first: no database connection/row lock during network I/O.
  // A process crash leaves running for manual review; there is no automatic retry.
  const result = claim.task.task_type === 'SEO_ANALYSIS' ? await analyze(claim.facts, claim.brand, generate) : await inspect(claim.brand);
  return transaction(async conn => {
    const [[task]] = await conn.execute('SELECT * FROM tasks WHERE task_key=? FOR UPDATE', [key]);
    if (!task || task.status !== 'running') fail(409, 'task_not_executable');
    await conn.execute("UPDATE tasks SET result_json=?,status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=?", [JSON.stringify(result), task.id]);
    await logTransition(conn, task, 'running', 'completed');
    await conn.execute(`INSERT INTO activity_logs (brand_id,agent_id,task_id,level,action,message,context_json)
      VALUES (?,?,?,'INFO','task.analysis',?,?)`, [task.brand_id, task.assigned_agent_id, task.id,
      task.task_type === 'SEO_ANALYSIS' ? 'SEO analysis finished' : 'Web QC check finished',
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
