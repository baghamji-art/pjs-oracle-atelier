'use strict';
const { rehearsalHandler } = require('./lib/member-rehearsal.cjs');
const { prepareAdminConsultWrite: readTestMember } = require('./lib/member-auth.cjs');
const { adminProjection } = require('./lib/member-management.cjs');
exports.handler = rehearsalHandler('GET', async (event, allowedIds) => {
  const query = event.queryStringParameters || {};
  if (Object.keys(query).length !== 1 || typeof query.memberId !== 'string') return { ok: false, status: 400, code: 'MEMBER_QUERY_INVALID' };
  const result = await readTestMember(query.memberId, allowedIds);
  if (!result.ok) return result;
  return { ok: true, status: 200, code: 'ADMIN_MEMBER_READY', member: adminProjection(result.member) };
});
