'use strict';
const { rehearsalHandler } = require('./lib/member-rehearsal.cjs');
const { clearMemberSessionCookie } = require('./lib/member-auth.cjs');
exports.handler = rehearsalHandler('POST', async () => ({
  ok: true, status: 200, code: 'MEMBER_LOGGED_OUT', cookie: clearMemberSessionCookie()
}));
