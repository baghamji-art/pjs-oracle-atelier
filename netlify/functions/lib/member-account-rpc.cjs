'use strict';
const { readServerConfig } = require('../_supabase-server-probe');
const { readBoundedJson } = require('./bounded-json.cjs');
const fail = (status, code) => ({ ok: false, status, code });
async function accountRpc(name, parameters) {
  if (!['pjo_member_register_v1', 'pjo_member_manage_v1'].includes(name)) return fail(503, 'MEMBER_WRITE_UNCONFIRMED');
  const config = readServerConfig();
  if (config.error) return fail(503, 'MEMBER_AUTH_NOT_CONFIGURED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(config.origin + '/rest/v1/rpc/' + name, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { apikey: config.key, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(parameters)
    });
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      return fail(503, 'MEMBER_WRITE_UNCONFIRMED');
    }
    const body = await readBoundedJson(response, 4096);
    const errors = { conflict: [409, 'MEMBER_CONFLICT'], unavailable: [409, 'MEMBER_ID_UNAVAILABLE'],
      invalid: [503, 'MEMBER_DATA_INVALID'], full: [409, 'MEMBER_STORAGE_FULL'], unauthorized: [401, 'ADMIN_LOGIN_REQUIRED'] };
    if (typeof body?.result === 'string' && Object.hasOwn(errors, body.result)) return fail(...errors[body.result]);
    const allowed = name === 'pjo_member_register_v1' ? ['created', 'unchanged'] : ['saved', 'unchanged'];
    return allowed.includes(body?.result) ? { ok: true, status: 200, result: body.result } : fail(503, 'MEMBER_WRITE_UNCONFIRMED');
  } catch (_) { return fail(503, 'MEMBER_WRITE_UNCONFIRMED'); }
  finally { clearTimeout(timer); }
}
module.exports = { accountRpc };
