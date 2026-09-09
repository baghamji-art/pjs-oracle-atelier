'use strict';
const { rehearsalHandler } = require('./lib/member-rehearsal.cjs');
const { parseObjectBody } = require('./_request-validation');
const { authenticateMember } = require('./lib/member-auth.cjs');

exports.handler = rehearsalHandler('POST', async (event, allowedIds) => {
  const parsed = parseObjectBody(event, 8192);
  if (parsed.error) return { ok: false, status: parsed.error, code: 'MEMBER_CREDENTIALS_INVALID' };
  const id = typeof parsed.body.id === 'string' ? parsed.body.id.trim() : '';
  if (!allowedIds.has(id)) return { ok: false, status: 401, code: 'MEMBER_LOGIN_REQUIRED' };
  return authenticateMember(parsed.body);
});
