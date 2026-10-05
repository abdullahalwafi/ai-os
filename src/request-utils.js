const pool = require("./db/mysql");
function fail(status, code) {
  const error = new Error(code);
  error.httpStatus = status;
  error.publicCode = code;
  throw error;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    let rejected = false;
    const bad = (status, code) => {
      rejected = true;
      chunks = [];
      const error = new Error(code);
      error.httpStatus = status;
      error.publicCode = code;
      reject(error);
    };
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > 256 * 1024) return bad(413, 'request_too_large');
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) return bad(400, 'invalid_json_body');
        resolve(body);
      } catch { bad(400, 'invalid_json'); }
    });
    req.on('error', () => bad(400, 'invalid_request'));
    req.on('aborted', () => bad(400, 'invalid_request'));
  });
}

async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally { conn.release(); }
}
module.exports = { fail, readJson, transaction };
