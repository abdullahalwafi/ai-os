// Hermes3D's custom HTTP provider reads /health, /state and /registry.
// See docs/task-015-hermes-runtime.md for the inspected contract and UI patch.
const pool = require('./db/mysql');

const PREFIX = '/hermes-runtime';
const ROLES = Object.freeze({
  GROUP_CEO: 'Group CEO', BRAND_CEO: 'Brand CEO', SEO_AGENT: 'SEO',
  CONTENT_AGENT: 'Content', WEB_QC_AGENT: 'Web QC', DEVELOPER_AGENT: 'Developer',
});

async function readAgents(db) {
  const [rows] = await db.query({
    sql: `SELECT a.id, a.agent_key, a.agent_type, a.name, a.status,
                 b.brand_key, b.name AS brand_name
          FROM agents a LEFT JOIN brands b ON b.id = a.brand_id
          ORDER BY a.id`,
    timeout: 5000,
  });
  const [tasks] = await db.query({
    sql: `SELECT t.assigned_agent_id, t.task_key, t.task_type, t.status,
                 b.brand_key, b.name AS brand_name
          FROM tasks t LEFT JOIN brands b ON b.id = t.brand_id
          WHERE t.status IN ('running', 'queued')
          ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END, t.id`,
    timeout: 5000,
  });
  const taskByAgent = new Map();
  for (const task of tasks) {
    if (!taskByAgent.has(task.assigned_agent_id)) taskByAgent.set(task.assigned_agent_id, task);
  }
  return rows.map(row => {
    const role = ROLES[row.agent_type] || row.agent_type;
    const name = row.name?.trim() || (row.brand_name ? `${row.brand_name} — ${role}` : role);
    const task = taskByAgent.get(row.id) || null;
    const logicalStatus = row.status !== 'active' ? 'offline' : task?.status === 'running' ? 'working' : 'idle';
    return {
      id: row.agent_key,
      name,
      identity: { name },
      role,
      // Hermes3D UI supports idle/running/error. Keep the logical offline/working
      // state in metadata and map queued/offline to the safest visible idle state.
      status: logicalStatus === 'working' ? 'running' : 'idle',
      metadata: {
        agent_key: row.agent_key, agent_type: row.agent_type,
        brand_key: row.brand_key, brand_name: row.brand_name,
        team: row.brand_name || 'Digital Musik Group / Headquarters',
        presence_status: logicalStatus,
        current_task_key: task?.task_key || null,
        current_task_type: task?.task_type || null,
        current_task_status: task?.status || null,
        current_task_brand: task?.brand_key || task?.brand_name || null,
      },
    };
  });
}

function createHandler(db = pool) {
  return async function handleHermesRuntime(req, res, sendJson, logError) {
    const pathname = req.url.split('?')[0];
    if (pathname !== PREFIX && !pathname.startsWith(PREFIX + '/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      req.resume();
      res.setHeader('Allow', 'GET');
      sendJson(res, 405, { error: 'read_only', message: 'This runtime supports registry reads only.' });
      return true;
    }
    const route = pathname.slice(PREFIX.length);
    if (!['/health', '/state', '/registry'].includes(route)) {
      sendJson(res, 404, { error: 'unsupported_read_only_operation' });
      return true;
    }
    try {
      if (route === '/health') {
        await db.query({ sql: 'SELECT 1', timeout: 5000 });
        sendJson(res, 200, { ok: true, status: 'ok', readOnly: true });
      } else if (route === '/state') {
        const agents = await readAgents(db);
        sendJson(res, 200, {
          profileName: 'dm-ai-os', readOnly: true,
          runtime: { name: 'DM AI OS', version: '1.0.0', vendor: 'Digital Musik Group', status: 'healthy', governance: 'read-only' },
          agents: agents.map(agent => ({ id: agent.id, status: agent.metadata.presence_status, metadata: agent.metadata })),
        });
      } else {
        const agents = await readAgents(db);
        sendJson(res, 200, {
          defaultId: agents.find(agent => agent.metadata.agent_type === 'GROUP_CEO')?.id || agents[0]?.id || null,
          mainKey: 'main', scope: 'custom', readOnly: true,
          capabilities: ['agents', 'agent-roles'], models: {}, agents,
        });
      }
    } catch (error) {
      logError('hermes_runtime_read', error);
      sendJson(res, 503, { ok: false, status: 'unavailable', error: 'runtime_unavailable' });
    }
    return true;
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
