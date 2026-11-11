'use strict';
const { rehearsalHandler } = require('./lib/member-rehearsal.cjs');
const { parseObjectBody } = require('./_request-validation');
const { prepareMemberWrite } = require('./lib/member-auth.cjs');
const { validateCommand, prepareChange, authSnapshot, revision } = require('./lib/archive-record.cjs');
const { readServerConfig } = require('./_supabase-server-probe');
const { readBoundedJson } = require('./lib/bounded-json.cjs');
const { verifyAdminSession, securityConfig } = require('./_admin-session');
const fail = (status, code) => ({ ok: false, status, code });

exports.handler = rehearsalHandler('POST', async (event, allowedIds) => {
  // Separate opt-in: enabling read rehearsals must never enable DB writes.
  if (process.env.MEMBER_ARCHIVE_WRITE_MODE !== 'rehearsal') return fail(503, 'ARCHIVE_WRITE_DISABLED');
  if (Object.keys(event.queryStringParameters || {}).length) return fail(400, 'ARCHIVE_COMMAND_INVALID');
  const parsed = parseObjectBody(event, 800 * 1024);
  if (parsed.error) return fail(parsed.error, 'ARCHIVE_COMMAND_INVALID');
  const command = parsed.body;
  if (!validateCommand(command)) return fail(400, 'ARCHIVE_COMMAND_INVALID');
  const auth = await prepareMemberWrite(event, allowedIds);
  if (!auth.ok) return auth;
  const change = prepareChange(auth.member, command);
  if (!change.ok) return change;
  const admin = verifyAdminSession(event, securityConfig().sessionSecret);
  if (!admin) return fail(401, 'ADMIN_LOGIN_REQUIRED');
  const config = readServerConfig();
  if (config.error) return fail(503, 'MEMBER_AUTH_NOT_CONFIGURED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // One fixed, service-role-only transaction. NEVER fall back to table PATCH/upsert.
    const response = await fetch(config.origin + '/rest/v1/rpc/pjo_archive_apply_v1', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { apikey: config.key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ p_member_id: auth.member.id, p_auth: authSnapshot(auth.member),
        p_valid_until: Math.min(auth.sessionExpiresAt, admin.exp), p_reading_id: command.readingId,
        p_expected: change.previous, p_next: change.next })
    });
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      return fail(503, 'ARCHIVE_WRITE_UNCONFIRMED');
    }
    const result = await readBoundedJson(response, 4096);
    const errors = { conflict: [409, 'ARCHIVE_CONFLICT'], full: [409, 'ARCHIVE_FULL'],
      unauthorized: [401, 'MEMBER_LOGIN_REQUIRED'], invalid: [503, 'MEMBER_DATA_INVALID'] };
    if (typeof result?.result === 'string' && Object.hasOwn(errors, result.result)) return fail(...errors[result.result]);
    if (!['unchanged', change.next ? 'saved' : 'deleted'].includes(result?.result)) return fail(503, 'ARCHIVE_WRITE_UNCONFIRMED');
    return { ok: true, status: 200, code: 'ARCHIVE_WRITE_CONFIRMED', readingId: command.readingId,
      result: result.result, revision: change.next ? revision(auth.member.id, change.next) : null };
  } catch (_) {
    // A timeout can occur AFTER commit. Do not claim failure/no-write or auto retry.
    return fail(503, 'ARCHIVE_WRITE_UNCONFIRMED');
  } finally { clearTimeout(timer); }
}, { mayWrite: true });
