const { createHash, timingSafeEqual } = require('crypto');

const key = process.env.DM_AI_API_KEY;
if (!key || Buffer.byteLength(key) < 32) {
  throw new Error('DM_AI_API_KEY must be configured with at least 32 bytes');
}
const digest = value => createHash('sha256').update(value).digest();
const expected = digest(key);

module.exports = function authorized(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (!match) return false;
  // Fixed-length digests allow constant-time comparison even for wrong lengths.
  return timingSafeEqual(expected, digest(match[1]));
};
