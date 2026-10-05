const { randomUUID } = require('crypto');
const { transaction, fail } = require('./request-utils');
const authorized = require('./auth');

async function processEvent(key) {
  return transaction(async conn => {
    const [[event]] = await conn.execute('SELECT * FROM events WHERE event_key=? FOR UPDATE', [key]);
    if (!event) fail(404, 'event_not_found');
    if (event.status !== 'pending') fail(409, 'event_already_finalized');
    if (event.event_type !== 'seo.keyword_declined') fail(422, 'unsupported_event_type');
    if (event.brand_id === null) fail(422, 'route_agent_not_found');
    const [[brand]] = await conn.execute('SELECT status FROM brands WHERE id=? FOR SHARE', [event.brand_id]);
    if (!brand || brand.status !== 'active') fail(422, 'route_brand_inactive');
    const [agents] = await conn.execute(`SELECT id,agent_key FROM agents
      WHERE brand_id=? AND agent_type='SEO_AGENT' AND status='active' FOR SHARE`, [event.brand_id]);
    if (!agents.length) fail(422, 'route_agent_not_found');
    if (agents.length !== 1) fail(422, 'route_agent_ambiguous');
    const payload = event.payload_json;
    if (!payload || typeof payload.keyword !== 'string' || !payload.keyword.trim() ||
        !Number.isInteger(payload.previous_rank) || payload.previous_rank < 1 ||
        !Number.isInteger(payload.current_rank) || payload.current_rank < 1) fail(422, 'invalid_event_payload');
    // Copy only the route's explicit fields, never arbitrary event payload keys.
    const context = { source_event_key: event.event_key, event_type: event.event_type,
      keyword: payload.keyword, previous_rank: payload.previous_rank, current_rank: payload.current_rank };
    const taskKey = 'TASK-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + randomUUID();
    const title = [...('Analyze ranking decline: ' + payload.keyword)].slice(0, 255).join('');
    const [insert] = await conn.execute(`INSERT INTO tasks
      (task_key,brand_id,assigned_agent_id,task_type,title,description,priority,status,payload_json)
      VALUES (?,?,?,'SEO_ANALYSIS',?,?,'P1','created',?)`, [taskKey, event.brand_id, agents[0].id, title,
      'Analyze the reported keyword ranking decline and identify SEO opportunities for this brand.', JSON.stringify(context)]);
    await conn.execute(`INSERT INTO activity_logs (brand_id,agent_id,task_id,level,action,message,context_json)
      VALUES (?,?,?,'INFO','task.created','Task created by event router',?)`,
    [event.brand_id, agents[0].id, insert.insertId, JSON.stringify({ source_event_key: event.event_key })]);
    await conn.execute("UPDATE events SET status='processed',processed_at=COALESCE(processed_at,CURRENT_TIMESTAMP) WHERE id=?", [event.id]);
    await conn.execute(`INSERT INTO activity_logs (brand_id,task_id,level,action,message,context_json)
      VALUES (?,?,'INFO','event.processed','Event routed to task',?)`,
    [event.brand_id, insert.insertId, JSON.stringify({ event_key: event.event_key, created_task_key: taskKey })]);
    return { success: true, event_key: event.event_key, event_status: 'processed',
      task: { task_key: taskKey, agent_key: agents[0].agent_key, task_type: 'SEO_ANALYSIS', priority: 'P1', status: 'created' } };
  });
}

module.exports = async function handleEventRouter(req, res, sendJson, logError) {
  const match = req.url.split('?')[0].match(/^\/events\/([^/]+)\/process$/);
  if (req.method !== 'POST' || !match) return false;
  req.resume(); // This endpoint uses only its path, not a request body.
  if (!authorized(req)) {
    sendJson(res, 401, { success: false, error: 'unauthorized' });
    return true;
  }
  try { sendJson(res, 200, await processEvent(match[1])); }
  catch (error) {
    if (!error.httpStatus) logError('event_router', error);
    sendJson(res, error.httpStatus || 500, { success: false, error: error.publicCode || 'internal_server_error' });
  }
  return true;
};
