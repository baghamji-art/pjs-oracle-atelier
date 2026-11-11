'use strict';
const { rehearsalHandler } = require('./member-rehearsal.cjs');
const { parseObjectBody } = require('../_request-validation');
const { prepareMemberWrite, prepareAdminConsultWrite } = require('./member-auth.cjs');
const { authSnapshot } = require('./archive-record.cjs');
const { readServerConfig } = require('../_supabase-server-probe');
const { readBoundedJson } = require('./bounded-json.cjs');
const { verifyAdminSession, securityConfig } = require('../_admin-session');
const fail = (status, code) => ({ ok: false, status, code });
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validCommand(command, role) {
  if (!object(command) || !['create', 'reply'].includes(command.action) ||
      !token(command.consultId) || !token(command.messageId) ||
      typeof command.message !== 'string' || !command.message.trim() || command.message.includes('\0') ||
      Buffer.byteLength(command.message, 'utf8') > 16000 || !['ko', 'en', 'zh'].includes(command.lang)) return false;
  const fields = ['action', 'consultId', 'messageId', 'message', 'lang', ...(role === 'admin' ? ['memberId'] : [])];
  if (Object.keys(command).some(key => !fields.includes(key))) return false;
  return role !== 'admin' || (command.action === 'reply' && typeof command.memberId === 'string' &&
    command.memberId.length > 0 && Buffer.byteLength(command.memberId, 'utf8') <= 256);
}

function consultHandler(role) {
  if (!['user', 'admin'].includes(role)) throw Error('Invalid server consultation role');
  return rehearsalHandler('POST', async (event, allowedIds) => {
    if (process.env.MEMBER_CONSULT_WRITE_MODE !== 'rehearsal') return fail(503, 'CONSULT_WRITE_DISABLED');
    if (Object.keys(event.queryStringParameters || {}).length) return fail(400, 'CONSULT_COMMAND_INVALID');
    const parsed = parseObjectBody(event, 65536);
    if (parsed.error) return fail(parsed.error, 'CONSULT_COMMAND_INVALID');
    const command = parsed.body;
    if (!validCommand(command, role)) return fail(400, 'CONSULT_COMMAND_INVALID');
    const auth = role === 'user' ? await prepareMemberWrite(event, allowedIds) :
      await prepareAdminConsultWrite(command.memberId, allowedIds);
    if (!auth.ok) return auth;
    const admin = verifyAdminSession(event, securityConfig().sessionSecret);
    if (!admin) return fail(401, 'ADMIN_LOGIN_REQUIRED');
    const config = readServerConfig();
    if (config.error) return fail(503, 'MEMBER_AUTH_NOT_CONFIGURED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      // Append one message to the locked latest row; never upload a logs array.
      const response = await fetch(config.origin + '/rest/v1/rpc/pjo_consult_append_v1', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { apikey: config.key, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ p_member_id: auth.member.id, p_auth: authSnapshot(auth.member),
          p_valid_until: Math.min(auth.sessionExpiresAt || admin.exp, admin.exp), p_role: role,
          p_action: command.action, p_consult_id: command.consultId, p_message_id: command.messageId,
          p_message: command.message, p_lang: command.lang })
      });
      if (!response.ok) {
        if (response.body) await response.body.cancel().catch(() => {});
        return fail(503, 'CONSULT_WRITE_UNCONFIRMED');
      }
      const result = await readBoundedJson(response, 4096);
      const errors = { conflict: [409, 'CONSULT_CONFLICT'], full: [409, 'CONSULT_STORAGE_FULL'],
        not_found: [404, 'CONSULT_NOT_FOUND'], unauthorized: [401, 'MEMBER_LOGIN_REQUIRED'], invalid: [503, 'MEMBER_DATA_INVALID'] };
      if (typeof result?.result === 'string' && Object.hasOwn(errors, result.result)) return fail(...errors[result.result]);
      if (!['sent', 'unchanged'].includes(result?.result) || !Number.isSafeInteger(result.time) || result.time < 0) {
        return fail(503, 'CONSULT_WRITE_UNCONFIRMED');
      }
      return { ok: true, status: 200, code: 'CONSULT_WRITE_CONFIRMED', result: result.result,
        consultId: command.consultId, messageId: command.messageId, time: result.time };
    } catch (_) { return fail(503, 'CONSULT_WRITE_UNCONFIRMED'); }
    finally { clearTimeout(timer); }
  }, { mayWrite: true, unconfirmedCode: 'CONSULT_WRITE_UNCONFIRMED' });
}
module.exports = { consultHandler, validCommand };
