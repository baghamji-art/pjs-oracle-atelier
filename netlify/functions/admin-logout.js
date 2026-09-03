const {
  clearSessionCookie,
  json
} = require('./_admin-session');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  return json(200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
};
