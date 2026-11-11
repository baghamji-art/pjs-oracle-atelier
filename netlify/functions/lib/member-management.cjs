'use strict';
const crypto = require('node:crypto');
const { authSnapshot } = require('./archive-record.cjs');
const PERMANENT_EXPIRY = 4102444800000; // Same sentinel as the current UI.
const PLANS = ['trial3', 'trial7', 'month1', 'month3', 'year1', 'permanent'];
const TIERS = ['member', 'premium', 'vip'];
const MANAGED = ['plan', 'tier', 'permanent', 'memo', 'uniqueCode', 'createdAt', 'lastApprovedAt', '_registration'];
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const bounded = (x, max) => typeof x === 'string' && !x.includes('\0') && Buffer.byteLength(x, 'utf8') <= max;
const validId = x => bounded(x, 256) && !!x.trim() && x === x.trim() && !/[\u0000-\u001f\u007f]/.test(x);
const exact = (obj, keys) => object(obj) && Object.keys(obj).length === keys.length && keys.every(k => Object.hasOwn(obj, k));

function canonical(x) {
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  if (object(x)) return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
  return JSON.stringify(x);
}
function sign(purpose, value) {
  const secret = process.env.MEMBER_SESSION_SECRET || '';
  if (secret.length < 32 || secret.length > 1024 || secret.trim() !== secret || secret === process.env.ADMIN_SESSION_SECRET) {
    throw Error('Member management not configured');
  }
  return crypto.createHmac('sha256', secret).update('pjo-member-management-v1:' + purpose + '\0').update(canonical(value)).digest('base64url');
}
function managementSnapshot(member) {
  return { ...authSnapshot(member), ...Object.fromEntries(MANAGED.map(k => [k, member[k] === undefined ? null : member[k]])) };
}
const managementRevision = member => sign('revision', managementSnapshot(member));
const registrationFingerprint = (id, password) => sign('registration', [id, password]);

function validRegistration(body) {
  return exact(body, ['id', 'password', 'requestId']) && validId(body.id) && bounded(body.password, 4096) && body.password.length > 0 &&
    typeof body.requestId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(body.requestId);
}
function validEntitlement(value, now = Date.now()) {
  return exact(value, ['plan', 'tier', 'permanent', 'expiresAt']) && PLANS.includes(value.plan) && TIERS.includes(value.tier) &&
    typeof value.permanent === 'boolean' && Number.isSafeInteger(value.expiresAt) &&
    (value.permanent ? value.plan === 'permanent' && value.expiresAt === PERMANENT_EXPIRY :
      value.plan !== 'permanent' && value.expiresAt > now && value.expiresAt < PERMANENT_EXPIRY);
}
function validAdminCommand(body) {
  if (!object(body) || !['approve', 'set-entitlement', 'set-memo'].includes(body.action) || !validId(body.memberId) ||
      typeof body.revision !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.revision)) return false;
  return body.action === 'set-memo' ? exact(body, ['action', 'memberId', 'revision', 'memo']) && bounded(body.memo, 16384) :
    exact(body, ['action', 'memberId', 'revision', 'entitlement']) && validEntitlement(body.entitlement);
}
function adminProjection(member) {
  const result = { id: member.id, revision: managementRevision(member) };
  for (const key of ['plan', 'tier', 'status', 'memo', 'uniqueCode']) if (typeof member[key] === 'string') result[key] = member[key];
  for (const key of ['paid', 'permanent']) if (typeof member[key] === 'boolean') result[key] = member[key];
  for (const key of ['createdAt', 'expiresAt', 'firstLoginAt', 'lastLoginAt', 'lastApprovedAt']) {
    if (member[key] === null || Number.isSafeInteger(member[key])) result[key] = member[key];
  }
  return result;
}
module.exports = { PERMANENT_EXPIRY, validRegistration, validAdminCommand, validEntitlement,
  managementSnapshot, managementRevision, registrationFingerprint, adminProjection };
