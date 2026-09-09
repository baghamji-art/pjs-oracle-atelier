'use strict';
const { securityConfig, verifyAdminSession, json } = require('./_admin-session');
const { auditMemberMigration } = require('./lib/member-auth.cjs');

exports.handler = async event => {
  const reply = (status, body) => json(status, body, {
    Vary: 'Cookie', Allow: 'GET', 'X-Robots-Tag': 'noindex, nofollow'
  });
  if (event.httpMethod !== 'GET') return reply(405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  const config = securityConfig();
  if (!config.valid) return reply(503, { ok: false, code: 'ADMIN_SECURITY_NOT_CONFIGURED' });
  if (!verifyAdminSession(event, config.sessionSecret)) return reply(401, { ok: false, code: 'ADMIN_LOGIN_REQUIRED' });
  const result = await auditMemberMigration();
  const { status, ...body } = result;
  return reply(status, body);
};
