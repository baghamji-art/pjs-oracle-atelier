const {
  json,
  securityConfig,
  verifyAdminSession
} = require('./_admin-session');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const config = securityConfig();
  if (!config.valid) return json(503, { error: 'Admin security is not configured' });

  const session = verifyAdminSession(event, config.sessionSecret);
  if (!session) return json(401, { authenticated: false });

  return json(200, {
    authenticated: true,
    expiresAt: session.exp
  });
};
