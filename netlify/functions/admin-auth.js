const {
  SESSION_SECONDS,
  issueSessionCookie,
  json,
  safeEqual,
  securityConfig
} = require('./_admin-session');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const config = securityConfig();
  if (!config.valid) {
    return json(503, { error: 'Admin security is not configured' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (error) {
    return json(400, { error: 'Invalid JSON body' });
  }

  const suppliedCode = String(body.code || '').slice(0, 256);
  if (!safeEqual(suppliedCode, config.adminCode)) {
    await minimumFailureDelay();
    return json(401, { error: 'Invalid administrator credentials' });
  }

  return json(200, {
    ok: true,
    expiresIn: SESSION_SECONDS
  }, {
    'Set-Cookie': issueSessionCookie(config.sessionSecret)
  });
};

function minimumFailureDelay() {
  return new Promise(resolve => setTimeout(resolve, 350));
}
