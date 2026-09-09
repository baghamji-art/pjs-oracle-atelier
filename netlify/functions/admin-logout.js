const {
  clearSessionCookie,
  json
} = require('./_admin-session');
const { validateBrowserMutation } = require('./lib/request-security.cjs');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const rejected = validateBrowserMutation(event);
  if (rejected) return json(rejected.status, { error: rejected.error });
  return json(200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
};
