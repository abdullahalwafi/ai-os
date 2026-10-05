require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  try {
    const conn = await mysql.createConnection({
      socketPath: process.env.DB_SOCKET,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });

    const [rows] = await conn.query(
      'SELECT DATABASE() AS db, NOW() AS now_time'
    );

    console.log(rows[0]);

    await conn.end();
  } catch (err) {
    console.error('DB ERROR:', err.message);
    process.exit(1);
  }
})();
