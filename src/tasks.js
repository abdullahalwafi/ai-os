const { randomUUID } = require('crypto');
const pool = require('./db/mysql');
const authorized = require('./auth');

const transitions = {
  created: ['queued'], queued: ['running'],
  running: ['waiting', 'need_approval', 'completed', 'failed'],
  waiting: ['queued', 'running', 'cancelled'],
  need_approval: ['queued', 'running', 'cancelled'],
  completed: [], failed: [], cancelled: [],
};
const statuses = Object.keys(transitions);
const fields = `t.task_key, b.brand_key, b.name AS brand_name,
  a.agent_key, a.name AS agent_name, a.agent_type, t.task_type, t.title,
  t.priority, t.status, t.created_at, t.started_at, t.completed_at`;
const joins = 'FROM tasks t LEFT JOIN brands b ON b.id=t.brand_id LEFT JOIN agents a ON a.id=t.assigned_agent_id';
const { fail, readJson, transaction } = require("./request-utils");

async function detail(conn, key) {
  const [rows] = await conn.execute(`SELECT ${fields}, t.description,
    t.payload_json AS payload, t.result_json AS result, t.updated_at ${joins} WHERE t.task_key=?`, [key]);
  if (!rows.length) fail(404, 'task_not_found');
  return rows[0];
}

async function audit(conn, task, action, context) {
  // Never copy request bodies, titles, descriptions or payloads into audit logs.
  await conn.execute(`INSERT INTO activity_logs
    (brand_id, agent_id, task_id, level, action, message, context_json)
    VALUES (?, ?, ?, 'INFO', ?, ?, ?)`,
  [task.brand_id, task.assigned_agent_id, task.id, action,
    action === 'task.created' ? 'Task created' : 'Task status changed', JSON.stringify(context)]);
}

async function create(body) {
  for (const [key, max] of Object.entries({ brand_key: 50, agent_key: 100, task_type: 100, title: 255 })) {
    if (typeof body[key] !== 'string' || !body[key].trim() || [...body[key]].length > max) fail(400, 'invalid_' + key);
  }
  if (!['P1', 'P2', 'P3', 'P4'].includes(body.priority)) fail(400, 'invalid_priority');
  if (body.description != null && (typeof body.description !== 'string' || Buffer.byteLength(body.description) > 65535)) fail(400, 'invalid_description');
  if (body.payload !== undefined && (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload))) fail(400, 'invalid_payload');
  return transaction(async conn => {
    const [[brand]] = await conn.execute('SELECT id, status FROM brands WHERE brand_key=? FOR SHARE', [body.brand_key]);
    if (!brand || brand.status !== 'active') fail(400, 'invalid_brand');
    const [[agent]] = await conn.execute('SELECT id, brand_id, agent_type, status FROM agents WHERE agent_key=? FOR SHARE', [body.agent_key]);
    if (!agent || agent.status !== 'active') fail(400, 'invalid_agent');
    if (agent.brand_id !== brand.id && !(agent.agent_type === 'GROUP_CEO' && agent.brand_id === null)) fail(400, 'agent_brand_mismatch');
    const key = 'TASK-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + randomUUID();
    const [insert] = await conn.execute(`INSERT INTO tasks
      (task_key,brand_id,assigned_agent_id,task_type,title,description,priority,status,payload_json)
      VALUES (?,?,?,?,?,?,?,'created',?)`, [key, brand.id, agent.id, body.task_type, body.title,
      body.description ?? null, body.priority, JSON.stringify(body.payload ?? {})]);
    await audit(conn, { id: insert.insertId, brand_id: brand.id, assigned_agent_id: agent.id }, 'task.created', {});
    return detail(conn, key);
  });
}

async function changeStatus(key, body) {
  if (!statuses.includes(body.status)) fail(400, 'invalid_status');
  return transaction(async conn => {
    const [[task]] = await conn.execute('SELECT id,brand_id,assigned_agent_id,status FROM tasks WHERE task_key=? FOR UPDATE', [key]);
    if (!task) fail(404, 'task_not_found');
    if (!transitions[task.status].includes(body.status)) fail(409, 'invalid_status_transition');
    await conn.execute(`UPDATE tasks SET status=?,
      started_at=CASE WHEN ?='running' THEN COALESCE(started_at,CURRENT_TIMESTAMP) ELSE started_at END,
      completed_at=CASE WHEN ? IN ('completed','failed','cancelled') THEN CURRENT_TIMESTAMP ELSE completed_at END
      WHERE id=?`, [body.status, body.status, body.status, task.id]);
    await audit(conn, task, 'task.status_changed', { from: task.status, to: body.status });
    return detail(conn, key);
  });
}

module.exports = async function handleTasks(req, res, sendJson, logError) {
  const [pathname, ...search] = req.url.split('?');
  const match = pathname.match(/^\/tasks\/([^/]+)(\/status)?$/);
  const isCreate = pathname === '/tasks' && req.method === 'POST';
  const isList = pathname === '/tasks' && req.method === 'GET';
  const isDetail = match && !match[2] && req.method === 'GET';
  const isPatch = match && match[2] && req.method === 'PATCH';
  if (!(isCreate || isList || isDetail || isPatch)) return false;
  if ((isCreate || isPatch) && !authorized(req)) {
    req.resume();
    sendJson(res, 401, { success: false, error: 'unauthorized' });
    return true;
  }
  try {
    if (isCreate) sendJson(res, 201, { success: true, data: await create(await readJson(req)) });
    else if (isPatch) sendJson(res, 200, { success: true, data: await changeStatus(match[1], await readJson(req)) });
    else if (isDetail) sendJson(res, 200, { success: true, data: await detail(pool, match[1]) });
    else {
      const query = new URLSearchParams(search.join('?'));
      const where = [];
      const values = [];
      for (const [key, column] of Object.entries({ brand: 'b.brand_key', status: 't.status', agent: 'a.agent_key' })) {
        if (query.has(key)) {
          if (key === 'status' && !statuses.includes(query.get(key))) fail(400, 'invalid_status');
          where.push(column + '=?');
          values.push(query.get(key));
        }
      }
      const [rows] = await pool.execute(`SELECT ${fields} ${joins}
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.id DESC`, values);
      sendJson(res, 200, { success: true, count: rows.length, data: rows });
    }
  } catch (error) {
    if (!error.httpStatus) logError('tasks_request', error);
    sendJson(res, error.httpStatus || 500, { success: false, error: error.publicCode || 'internal_server_error' });
  }
  return true;
};
// Hermes safe command gate reuses the same validated transaction path without
// exposing a new public route or bypassing audit/brand/agent checks.
module.exports.createTask = create;
