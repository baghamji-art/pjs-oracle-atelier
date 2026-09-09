'use strict';
const { rehearsalHandler } = require('./lib/member-rehearsal.cjs');
const { readMemberData } = require('./lib/member-auth.cjs');
exports.handler = rehearsalHandler('GET', async (event, allowedIds) => {
  const query = event.queryStringParameters || {};
  const resource = query.resource || 'account';
  // No caller-supplied member ID, table, column, filter or alternate upstream.
  if (Object.keys(query).some(key => !['resource', 'readingId'].includes(key)) ||
      !['account', 'history', 'reading', 'consultations'].includes(resource) ||
      (resource === 'reading' && (typeof query.readingId !== 'string' || !query.readingId ||
        Buffer.byteLength(query.readingId, 'utf8') > 256)) ||
      (resource !== 'reading' && query.readingId !== undefined)) {
    return { ok: false, status: 400, code: 'MEMBER_QUERY_INVALID' };
  }
  return readMemberData(event, resource, query.readingId, allowedIds);
});
