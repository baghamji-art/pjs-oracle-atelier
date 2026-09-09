'use strict';
const { rehearsalHandler } = require('./lib/member-rehearsal.cjs');
const { verifyMemberSession } = require('./lib/member-auth.cjs');
exports.handler = rehearsalHandler('GET', (event, allowedIds) => verifyMemberSession(event, allowedIds));
