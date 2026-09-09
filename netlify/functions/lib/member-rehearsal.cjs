'use strict';
const { securityConfig, verifyAdminSession, json } = require('../_admin-session');
const { validateBrowserMutation } = require('./request-security.cjs');

function gate(event) {
  // No public/production mode exists yet. Environment typos fail closed.
  if (process.env.MEMBER_ACCESS_MODE !== 'rehearsal') return { status: 503, code: 'MEMBER_ACCESS_DISABLED' };
  const config = securityConfig();
  if (!config.valid) return { status: 503, code: 'ADMIN_SECURITY_NOT_CONFIGURED' };
  if (!verifyAdminSession(event, config.sessionSecret)) return { status: 401, code: 'ADMIN_LOGIN_REQUIRED' };
  const raw = process.env.MEMBER_REHEARSAL_IDS || '';
  const ids = raw.split(',').map(value => value.trim());
  if (raw.length > 4096 || ids.length > 20 || ids.some(id => !id || Buffer.byteLength(id, 'utf8') > 256)) {
    return { status: 503, code: 'MEMBER_REHEARSAL_NOT_CONFIGURED' };
  }
  return { allowedIds: new Set(ids) };
}

function reply(status, body, method, extra = {}) {
  // Keep buffered responses bounded even when legacy saved HTML is very large.
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 4 * 1024 * 1024) {
    status = 503;
    body = { ok: false, code: 'MEMBER_RESPONSE_TOO_LARGE' };
    extra = {};
  }
  return json(status, body, {
    Vary: 'Cookie', Allow: method, 'X-Robots-Tag': 'noindex, nofollow', ...extra
  });
}

function rehearsalHandler(method, action) {
  return async event => {
    const send = result => {
      const { status, cookie, ...body } = result;
      return reply(status, body, method, cookie ? { 'Set-Cookie': cookie } : {});
    };
    if (event.httpMethod !== method) return send({ ok: false, status: 405, code: 'METHOD_NOT_ALLOWED' });
    const access = gate(event);
    if (access.status) return send({ ok: false, ...access });
    if (method === 'POST') {
      const rejected = validateBrowserMutation(event);
      if (rejected) return send({ ok: false, status: rejected.status, code: 'REQUEST_REJECTED' });
    }
    try {
      const result = await action(event, access.allowedIds);
      // Expired admin sessions must not deliver data/cookies after a slow DB call.
      const recheck = gate(event);
      if (recheck.status) return send({ ok: false, ...recheck });
      return send(result);
    } catch (_) {
      // Do not expose exception text, passwords, source records or server keys.
      return send({ ok: false, status: 503, code: 'MEMBER_ACCESS_UNAVAILABLE' });
    }
  };
}

module.exports = { rehearsalHandler };
