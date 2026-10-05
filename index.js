const http = require('http');
const handleLLMTest = require('./src/llm-test');
const pool = require('./src/db/mysql');
const handleTasks = require('./src/tasks');
const handleEvents = require('./src/events');
const handleEventRouter = require('./src/event-router');
const handleWorker = require('./src/worker-executor');

const PORT = Number(process.env.PORT || 3100);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('Invalid PORT configuration');
}

// Log only numeric driver metadata, never error messages or connection options.
function logError(context, error) {
  console.error(JSON.stringify({
    level: 'ERROR',
    context,
    errno: Number.isInteger(error.errno) ? error.errno : undefined,
  }));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function checkDatabase() {
  await pool.query({ sql: 'SELECT 1', timeout: 5000 });
}

const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  if (req.method === 'GET' && pathname === '/health') {
    let available = true;
    try {
      await checkDatabase();
    } catch (error) {
      available = false;
      logError('health_database_check', error);
    }
    return sendJson(res, available ? 200 : 503, {
      status: available ? 'ok' : 'degraded',
      service: 'dm-ai-os',
      database: available ? 'ok' : 'error',
      time: new Date().toISOString()
    });
  }

  if (req.method === 'GET' && pathname === '/brands') {
    try {
      const [rows] = await pool.query({
        sql: 'SELECT brand_key, name, domain, website_url, status FROM brands ORDER BY id',
        timeout: 5000,
      });
      return sendJson(res, 200, { success: true, count: rows.length, data: rows });
    } catch (error) {
      logError('brands_query', error);
      return sendJson(res, 500, { success: false, error: 'internal_server_error' });
    }
  }

  if (req.method === 'GET' && pathname === '/agents') {
    const query = new URLSearchParams(req.url.split('?').slice(1).join('?'));
    const brand = query.get('brand');
    try {
      const [rows] = await pool.query({
        sql: `SELECT a.agent_key, a.agent_type, a.name, a.status,
                     b.brand_key, b.name AS brand_name
              FROM agents a
              LEFT JOIN brands b ON b.id = a.brand_id
              ${brand !== null ? 'WHERE b.brand_key = ?' : ''}
              ORDER BY a.id`,
        values: brand !== null ? [brand] : [],
        timeout: 5000,
      });
      return sendJson(res, 200, { success: true, count: rows.length, data: rows });
    } catch (error) {
      logError('agents_query', error);
      return sendJson(res, 500, { success: false, error: 'internal_server_error' });
    }
  }

  if (await handleTasks(req, res, sendJson, logError)) return;
  if (await handleEvents(req, res, sendJson, logError)) return;
  if (await handleEventRouter(req, res, sendJson, logError)) return;
  if (await handleWorker(req, res, sendJson, logError)) return;
  if (await handleLLMTest(req, res, sendJson, logError)) return;
  sendJson(res, 404, { error: 'not_found' });
});

server.on('error', async (error) => {
  logError('http_server', error);
  await pool.end();
  process.exitCode = 1;
});

async function start() {
  try {
    await checkDatabase();
    console.log('INFO Database connection: OK');
  } catch (error) {
    logError('startup_database_check', error);
  }
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`INFO DM AI OS running on http://127.0.0.1:${PORT}`);
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    server.close(async () => {
      await pool.end();
      clearTimeout(deadline);
    });
  });
}

start();
