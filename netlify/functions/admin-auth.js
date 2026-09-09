const {
  SESSION_SECONDS,
  issueSessionCookie,
  json,
  safeEqual,
  securityConfig
} = require('./_admin-session');
const { parseObjectBody } = require('./_request-validation');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const config = securityConfig();
  if (!config.valid) {
    return json(503, { error: 'Admin security is not configured' });
  }

  const parsed = parseObjectBody(event, 4096);
  if (parsed.error) return json(parsed.error, { error: parsed.error === 413 ? 'Request body too large' : 'Invalid JSON body' });
  const body = parsed.body;

  if (typeof body.code !== 'string' || body.code.length > 256) {
    return json(400, { error: 'Invalid administrator credentials' });
  }
  const suppliedCode = body.code;
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
