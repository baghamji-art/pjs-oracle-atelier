'use strict';
const { securityConfig, verifyAdminSession, json } = require('./_admin-session');
const { probeAppState } = require('./_supabase-server-probe');

function reply(status, payload) {
  return json(status, payload, {
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Cookie',
    Allow: 'GET'
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return reply(405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  const config = securityConfig();
  if (!config.valid) return reply(503, { ok: false, code: 'ADMIN_SECURITY_NOT_CONFIGURED' });
  // Authenticate BEFORE inspecting server DB configuration or making any DB request.
  if (!verifyAdminSession(event, config.sessionSecret)) {
    return reply(401, { ok: false, code: 'ADMIN_LOGIN_REQUIRED' });
  }
  const result = await probeAppState();
  return reply(result.status, {
    ok: result.status === 200,
    code: result.code,
    mode: 'read-only',
    // A successful probe does not mean the legacy public data path is secured.
    dataAccessMigrationComplete: false
  });
};
