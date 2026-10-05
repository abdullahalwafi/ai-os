const { randomUUID } = require('crypto');
const pool = require('./db/mysql');
const authorized = require('./auth');
const { fail, readJson, transaction } = require('./request-utils');

const statuses = ['pending', 'processed', 'failed'];
const fields = `e.event_key, b.brand_key, b.name AS brand_name,
  e.event_type, e.source, e.status, e.created_at, e.processed_at`;
const joins = 'FROM events e LEFT JOIN brands b ON b.id=e.brand_id';

async function detail(conn, key) {
  const [[row]] = await conn.execute(`SELECT ${fields}, e.payload_json AS payload ${joins} WHERE e.event_key=?`, [key]);
  if (!row) fail(404, 'event_not_found');
  return row;
}

async function audit(conn, event, action, context) {
  // Link via generated event_key: activity_logs has no event_id column.
  // Do not copy caller payload, source or other free text into logs.
  await conn.execute(`INSERT INTO activity_logs (brand_id, level, action, message, context_json)
    VALUES (?, 'INFO', ?, ?, ?)`, [event.brand_id, action,
    action === 'event.created' ? 'Event created' : 'Event status changed',
    JSON.stringify({ event_key: event.event_key, ...context })]);
}

async function create(body) {
  for (const [key, max] of Object.entries({ event_type: 150, source: 100 })) {
    if (typeof body[key] !== 'string' || !body[key].trim() || [...body[key]].length > max) fail(400, 'invalid_' + key);
  }
  if (body.brand_key != null && (typeof body.brand_key !== 'string' || !body.brand_key.trim() || body.brand_key.length > 50)) fail(400, 'invalid_brand_key');
  if (body.payload !== undefined && (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload))) fail(400, 'invalid_payload');
  return transaction(async conn => {
    let brandId = null;
    if (body.brand_key != null) {
      const [[brand]] = await conn.execute('SELECT id,status FROM brands WHERE brand_key=? FOR SHARE', [body.brand_key]);
      if (!brand || brand.status !== 'active') fail(400, 'invalid_brand');
      brandId = brand.id;
    }
    const key = 'EVT-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + randomUUID();
    await conn.execute(`INSERT INTO events (event_key,brand_id,event_type,source,payload_json,status)
      VALUES (?,?,?,?,?,'pending')`, [key, brandId, body.event_type, body.source, JSON.stringify(body.payload ?? {})]);
    await audit(conn, { event_key: key, brand_id: brandId }, 'event.created', {});
    return detail(conn, key);
  });
}

async function changeStatus(key, body) {
  if (!statuses.includes(body.status)) fail(400, 'invalid_status');
  return transaction(async conn => {
    const [[event]] = await conn.execute('SELECT id,event_key,brand_id,status FROM events WHERE event_key=? FOR UPDATE', [key]);
    if (!event) fail(404, 'event_not_found');
    if (event.status !== 'pending' || body.status === 'pending') fail(409, 'invalid_status_transition');
    await conn.execute('UPDATE events SET status=?,processed_at=COALESCE(processed_at,CURRENT_TIMESTAMP) WHERE id=?', [body.status, event.id]);
    await audit(conn, event, 'event.status_changed', { from: event.status, to: body.status });
    return detail(conn, key);
  });
}

module.exports = async function handleEvents(req, res, sendJson, logError) {
  const [pathname, ...search] = req.url.split('?');
  const match = pathname.match(/^\/events\/([^/]+)(\/status)?$/);
  const isCreate = pathname === '/events' && req.method === 'POST';
  const isList = pathname === '/events' && req.method === 'GET';
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
      const where = [], values = [];
      for (const [key, column] of Object.entries({ brand: 'b.brand_key', status: 'e.status', type: 'e.event_type' })) {
        if (query.has(key)) {
          if (key === 'status' && !statuses.includes(query.get(key))) fail(400, 'invalid_status');
          where.push(column + '=?');
          values.push(query.get(key));
        }
      }
      const [rows] = await pool.execute(`SELECT ${fields} ${joins}
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.id DESC`, values);
      sendJson(res, 200, { success: true, count: rows.length, data: rows });
    }
  } catch (error) {
    if (!error.httpStatus) logError('events_request', error);
    sendJson(res, error.httpStatus || 500, { success: false, error: error.publicCode || 'internal_server_error' });
  }
  return true;
};
