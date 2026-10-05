const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const mysql = require('mysql2/promise');

for (const key of ['DB_SOCKET', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
  if (!process.env[key]) throw new Error(`Missing required configuration: ${key}`);
}

const pool = mysql.createPool({
  socketPath: process.env.DB_SOCKET,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 3,
  maxIdle: 1,
  idleTimeout: 60000,
  waitForConnections: true,
  queueLimit: 10,
  connectTimeout: 5000,
});

module.exports = pool;
