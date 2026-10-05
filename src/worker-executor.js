const { transaction, fail } = require('./request-utils');
const authorized = require('./auth');

function analyzeSeo(payload) {
  if (!payload || typeof payload.keyword !== 'string' || !payload.keyword.trim() ||
      !Number.isSafeInteger(payload.previous_rank) || payload.previous_rank < 1 ||
      !Number.isSafeInteger(payload.current_rank) || payload.current_rank < 1) {
    fail(422, 'invalid_task_payload');
  }
  const drop = payload.current_rank - payload.previous_rank;
  return { analysis_version: 1, keyword: payload.keyword,
    previous_rank: payload.previous_rank, current_rank: payload.current_rank,
    rank_change: -drop, severity: drop <= 0 ? 'none' : drop <= 3 ? 'low' : drop <= 10 ? 'medium' : 'high',
    recommendation: 'manual_review_required' };
}

async function logTransition(conn, task, from, to) {
  await conn.execute(`INSERT INTO activity_logs
    (brand_id,agent_id,task_id,level,action,message,context_json)
    VALUES (?,?,?,'INFO','task.status_changed','Worker changed task status',?)`,
  [task.brand_id, task.assigned_agent_id, task.id, JSON.stringify({ from, to })]);
}

async function executeTask(key) {
  return transaction(async conn => {
    const [[task]] = await conn.execute('SELECT * FROM tasks WHERE task_key=? FOR UPDATE', [key]);
    if (!task) fail(404, 'task_not_found');
    if (!['created', 'queued'].includes(task.status)) fail(409, 'task_not_executable');
    if (task.task_type !== 'SEO_ANALYSIS') fail(422, 'unsupported_task_type');
    if (task.assigned_agent_id === null) fail(422, 'invalid_agent_for_task');
    const [[agent]] = await conn.execute('SELECT status,agent_type,brand_id FROM agents WHERE id=? FOR SHARE', [task.assigned_agent_id]);
    if (!agent || agent.status !== 'active' || agent.agent_type !== 'SEO_AGENT' || agent.brand_id !== task.brand_id) {
      fail(422, 'invalid_agent_for_task');
    }
    await conn.execute("UPDATE tasks SET status='running',started_at=COALESCE(started_at,CURRENT_TIMESTAMP) WHERE id=?", [task.id]);
    await logTransition(conn, task, task.status, 'running');
    // This synchronous placeholder is deliberately short enough to run inside the transaction.
    // Future network/LLM workers need a different execution design.
    const result = analyzeSeo(task.payload_json);
    await conn.execute("UPDATE tasks SET result_json=?,status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=?", [JSON.stringify(result), task.id]);
    await logTransition(conn, task, 'running', 'completed');
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
