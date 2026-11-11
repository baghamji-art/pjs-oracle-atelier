'use strict';
const crypto = require('node:crypto');
const { rehearsalHandler } = require('./lib/member-rehearsal.cjs');
const { parseObjectBody } = require('./_request-validation');
const { prepareAdminConsultWrite: readTestMember } = require('./lib/member-auth.cjs');
const { validAdminCommand, managementRevision, managementSnapshot } = require('./lib/member-management.cjs');
const { verifyAdminSession, securityConfig } = require('./_admin-session');
const { accountRpc } = require('./lib/member-account-rpc.cjs');
const fail = (status, code) => ({ ok: false, status, code });
exports.handler = rehearsalHandler('POST', async (event, allowedIds) => {
  if (process.env.MEMBER_ACCOUNT_WRITE_MODE !== 'rehearsal') return fail(503, 'MEMBER_ACCOUNT_WRITE_DISABLED');
  if (Object.keys(event.queryStringParameters || {}).length) return fail(400, 'MEMBER_COMMAND_INVALID');
  const parsed = parseObjectBody(event, 65536);
  if (parsed.error) return fail(parsed.error, 'MEMBER_COMMAND_INVALID');
  const command = parsed.body;
  if (!validAdminCommand(command)) return fail(400, 'MEMBER_COMMAND_INVALID');
  const auth = await readTestMember(command.memberId, allowedIds);
  if (!auth.ok) return auth;
  if (!crypto.timingSafeEqual(Buffer.from(command.revision), Buffer.from(managementRevision(auth.member)))) return fail(409, 'MEMBER_CONFLICT');
  const admin = verifyAdminSession(event, securityConfig().sessionSecret);
  if (!admin) return fail(401, 'ADMIN_LOGIN_REQUIRED');
  const payload = command.action === 'set-memo' ? { memo: command.memo } : command.entitlement;
  const result = await accountRpc('pjo_member_manage_v1', { p_member_id: auth.member.id, p_expected: managementSnapshot(auth.member),
    p_valid_until: admin.exp, p_action: command.action, p_payload: payload });
  return result.ok ? { ...result, code: 'MEMBER_UPDATE_CONFIRMED', memberId: auth.member.id, next: 'admin-member' } : result;
}, { mayWrite: true, unconfirmedCode: 'MEMBER_WRITE_UNCONFIRMED' });
