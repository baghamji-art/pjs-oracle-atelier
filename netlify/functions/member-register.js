'use strict';
const { rehearsalHandler } = require('./lib/member-rehearsal.cjs');
const { parseObjectBody } = require('./_request-validation');
const { validRegistration, registrationFingerprint } = require('./lib/member-management.cjs');
const { hashPassword } = require('./lib/member-password.cjs');
const { verifyAdminSession, securityConfig } = require('./_admin-session');
const { accountRpc } = require('./lib/member-account-rpc.cjs');
const fail = (status, code) => ({ ok: false, status, code });

exports.handler = rehearsalHandler('POST', async (event, allowedIds) => {
  if (process.env.MEMBER_ACCOUNT_WRITE_MODE !== 'rehearsal') return fail(503, 'MEMBER_ACCOUNT_WRITE_DISABLED');
  if (process.env.MEMBER_SIGNUP_POLICY !== 'instant-permanent') return fail(503, 'MEMBER_SIGNUP_POLICY_REQUIRED');
  if (Object.keys(event.queryStringParameters || {}).length) return fail(400, 'MEMBER_REGISTRATION_INVALID');
  const parsed = parseObjectBody(event, 32768);
  if (parsed.error) return fail(parsed.error, 'MEMBER_REGISTRATION_INVALID');
  if (!validRegistration(parsed.body)) return fail(400, 'MEMBER_REGISTRATION_INVALID');
  const { id, password, requestId } = parsed.body;
  if (!allowedIds.has(id)) return fail(401, 'MEMBER_REHEARSAL_ONLY');
  const fingerprint = registrationFingerprint(id, password);
  const hash = await hashPassword(password);
  // Hashing can take time: recheck admin authorization before sending a write.
  const admin = verifyAdminSession(event, securityConfig().sessionSecret);
  if (!admin) return fail(401, 'ADMIN_LOGIN_REQUIRED');
  const result = await accountRpc('pjo_member_register_v1', { p_member_id: id, p_password_hash: hash,
    p_request_id: requestId, p_fingerprint: fingerprint, p_valid_until: admin.exp });
  if (!result.ok) return result;
  return { ...result, code: 'MEMBER_REGISTRATION_CONFIRMED', member: { type: 'member', id }, next: 'member-login' };
}, { mayWrite: true, unconfirmedCode: 'MEMBER_WRITE_UNCONFIRMED' });
