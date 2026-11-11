'use strict';

// Internal authentication. HTTP adapters are administrator-gated rehearsals only.
// No frontend cutover or DB writes. See MEMBER-ACCESS-REHEARSAL.md.
const crypto = require('node:crypto');
const { readServerConfig } = require('../_supabase-server-probe');
const { verifyPassword, hasValidCredential } = require('./member-password.cjs');
const { projectMemberData } = require('./member-data.cjs');

const COOKIE_NAME = 'pjo_member_session';
const SESSION_SECONDS = 20 * 60;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MEMBERS = 10000;
const fail = (status, code) => ({ ok: false, status, code });
const denied = () => fail(401, 'MEMBER_LOGIN_REQUIRED');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedString = (value, max) => typeof value === 'string' &&
  value.length > 0 && Buffer.byteLength(value, 'utf8') <= max;

function sessionSecret() {
  const secret = process.env.MEMBER_SESSION_SECRET || '';
  // Independent server secret: never fall back to a password, browser key or
  // administrator signing secret. Configure only as part of a future cutover.
  return secret.length >= 32 && secret.length <= 1024 &&
    secret !== process.env.ADMIN_SESSION_SECRET && secret.trim() === secret ? secret : null;
}

function mac(value, secret, purpose) {
  return crypto.createHmac('sha256', secret)
    .update('pjo-member-v1:' + purpose + '\0').update(value).digest('base64url');
}

function constantEqual(left, right) {
  // Compare fixed-length digests rather than branching on password length.
  const digest = value => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function credentialVersion(member, secret) {
  // Keyed (not a public password hash): no offline password-check oracle in cookie.
  const credential = Object.hasOwn(member, 'passwordHash') ? ['hash', member.passwordHash] : member.password;
  return mac(JSON.stringify([member.id, credential]), secret, 'credential');
}

function eligible(member, now) {
  // Conservative pre-test-mode statuses; do not activate before auditing legacy
  // accounts. Never silently mark accounts paid, active, permanent or renewed.
  if (!['approved', 'active', 'expiring_soon'].includes(member.status) || member.paid === false) return false;
  if (member.expiresAt !== undefined && member.expiresAt !== null) {
    if (!Number.isSafeInteger(member.expiresAt) || member.expiresAt <= now) return false;
  }
  return hasValidCredential(member);
}

async function readMembers(includeLogs = false) {
  const config = readServerConfig();
  if (config.error) return { error: fail(503, 'MEMBER_AUTH_NOT_CONFIGURED') };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let reader;
  try {
    // Existing schema forces a server-side read of the members array. Never
    // return it or proxy query parameters. Logs are fetched only for own-data
    // projection, in the SAME snapshot as the credential/status recheck.
    const fields = includeLogs ? 'id,members,logs' : 'id,members';
    const response = await fetch(config.origin + '/rest/v1/app_state?select=' + fields + '&id=eq.main&limit=1', {
      method: 'GET', headers: { apikey: config.key, Accept: 'application/json' },
      redirect: 'error', signal: controller.signal
    });
    if (!response.ok || !response.body) {
      if (response.body) await response.body.cancel().catch(() => {});
      return { error: fail(503, 'MEMBER_AUTH_UNAVAILABLE') };
    }
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return { error: fail(503, 'MEMBER_DATA_INVALID') };
      }
      chunks.push(Buffer.from(part.value));
    }
    const rows = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== 'main' ||
        !Array.isArray(rows[0].members) || rows[0].members.length > MAX_MEMBERS) {
      return { error: fail(503, 'MEMBER_DATA_INVALID') };
    }
    const ids = new Set();
    for (const member of rows[0].members) {
      if (!object(member) || !boundedString(member.id, 256) || ids.has(member.id)) {
        return { error: fail(503, 'MEMBER_DATA_INVALID') };
      }
      ids.add(member.id);
    }
    if (includeLogs && (!Array.isArray(rows[0].logs) || rows[0].logs.length > 10000)) {
      return { error: fail(503, 'MEMBER_DATA_INVALID') };
    }
    return { members: rows[0].members, ...(includeLogs ? { logs: rows[0].logs } : {}) };
  } catch (_) {
    // Never log or include upstream errors/records/credentials in the response.
    return { error: fail(503, 'MEMBER_AUTH_UNAVAILABLE') };
  } finally {
    if (reader) reader.releaseLock();
    clearTimeout(timer);
  }
}

function serializeCookie(value, maxAge) {
  return `${COOKIE_NAME}=${value}; Path=/.netlify/functions/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function identity(member) {
  // Explicit allowlist. Never spread a DB record, including one user's record.
  // No password, memo, history, logs, plan/role claims or other user's details.
  return { type: 'member', id: member.id };
}

async function authenticateMember(credentials) {
  const secret = sessionSecret();
  if (!secret) return fail(503, 'MEMBER_AUTH_NOT_CONFIGURED');
  if (!object(credentials) || !boundedString(credentials.id, 256) ||
      !credentials.id.trim() || !boundedString(credentials.password, 4096)) {
    return fail(400, 'MEMBER_CREDENTIALS_INVALID');
  }
  const result = await readMembers();
  if (result.error) return result.error;
  const member = result.members.find(item => item.id === credentials.id.trim());
  let matches;
  try { matches = await verifyPassword(credentials.password, member); }
  catch (_) { return fail(503, 'MEMBER_AUTH_UNAVAILABLE'); }
  // Same external failure for missing ID, wrong password or ineligible status.
  if (!member || !matches || !eligible(member, Date.now())) return denied();
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1, role: 'member', sub: member.id, iat: now, exp: now + SESSION_SECONDS,
    jti: crypto.randomBytes(16).toString('base64url'), cv: credentialVersion(member, secret)
  })).toString('base64url');
  return { ok: true, status: 200, code: 'MEMBER_AUTHENTICATED', member: identity(member),
    cookie: serializeCookie(payload + '.' + mac(payload, secret, 'session'), SESSION_SECONDS) };
}

function parseSession(event, secret) {
  const header = event?.headers?.cookie || event?.headers?.Cookie || '';
  if (typeof header !== 'string' || header.length > 16384) return null;
  const tokens = header.split(';').map(pair => pair.trim())
    .filter(pair => pair.startsWith(COOKIE_NAME + '='));
  if (tokens.length !== 1) return null;
  const token = tokens[0].slice(COOKIE_NAME.length + 1);
  if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [payload, signature] = token.split('.');
  if (!constantEqual(signature, mac(payload, secret, 'session'))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (!object(claims) || claims.v !== 1 || claims.role !== 'member' ||
        !boundedString(claims.sub, 256) || !Number.isSafeInteger(claims.iat) ||
        !Number.isSafeInteger(claims.exp) || claims.iat > now || claims.exp <= now ||
        claims.exp - claims.iat !== SESSION_SECONDS ||
        typeof claims.jti !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(claims.jti) ||
        typeof claims.cv !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(claims.cv)) return null;
    return claims;
  } catch (_) { return null; }
}

async function resolveMemberSession(event, includeLogs = false, allowedIds = null) {
  const secret = sessionSecret();
  if (!secret) return fail(503, 'MEMBER_AUTH_NOT_CONFIGURED');
  const claims = parseSession(event, secret);
  if (!claims) return denied(); // No DB access for an unsigned/invalid caller.
  if (allowedIds && !allowedIds.has(claims.sub)) return denied();
  const result = await readMembers(includeLogs);
  if (result.error) return result.error;
  const member = result.members.find(item => item.id === claims.sub);
  if (claims.exp <= Math.floor(Date.now() / 1000) || !member || !eligible(member, Date.now()) ||
      !constantEqual(claims.cv, credentialVersion(member, secret))) return denied();
  // Private helper only. Raw record must never cross the HTTP boundary.
  return { ok: true, member, logs: result.logs, sessionExpiresAt: claims.exp };
}

async function verifyMemberSession(event, allowedIds = null) {
  const result = await resolveMemberSession(event, false, allowedIds);
  if (!result.ok) return result;
  return { ok: true, status: 200, code: 'MEMBER_AUTHENTICATED', member: identity(result.member) };
}

async function readMemberData(event, resource, readingId, allowedIds) {
  const result = await resolveMemberSession(event, resource === 'consultations', allowedIds);
  if (!result.ok) return result;
  return projectMemberData(result.member, result.logs, resource, readingId);
}

function clearMemberSessionCookie() {
  // Browser cookie clearing only; a copied token is not server-revoked by this.
  return serializeCookie('', 0);
}

async function auditMemberMigration() {
  // Caller must already be an authenticated administrator. Counts only, never
  // IDs, passwords, hashes of passwords, messages, or source records.
  const result = await readMembers();
  if (result.error) return result.error;
  const counts = {
    total: result.members.length, eligibleForPreparedAuth: 0, requiresReview: 0,
    legacyPlaintextPassword: 0, hashedPassword: 0, invalidPasswordFormat: 0, permanent: 0,
    missingExpiry: 0, invalidExpiryFormat: 0, expired: 0, unpaid: 0
  };
  const statuses = { active: 0, approved: 0, expiring_soon: 0, pending: 0,
    renew_pending: 0, expired: 0, other: 0 };
  const now = Date.now();
  for (const member of result.members) {
    if (eligible(member, now)) counts.eligibleForPreparedAuth++; else counts.requiresReview++;
    if (boundedString(member.password, 4096)) counts.legacyPlaintextPassword++;
    if (Object.hasOwn(member, 'passwordHash') && hasValidCredential(member)) counts.hashedPassword++;
    if (!hasValidCredential(member)) counts.invalidPasswordFormat++;
    if (member.permanent === true) counts.permanent++;
    if (member.paid === false) counts.unpaid++;
    if (member.expiresAt === undefined || member.expiresAt === null) counts.missingExpiry++;
    else if (!Number.isSafeInteger(member.expiresAt)) counts.invalidExpiryFormat++;
    else if (member.expiresAt <= now) counts.expired++;
    const status = typeof member.status === 'string' && Object.hasOwn(statuses, member.status) ? member.status : 'other';
    statuses[status]++;
  }
  return { ok: true, status: 200, code: 'MEMBER_MIGRATION_AUDIT', counts, statuses,
    mode: 'read-only', dataAccessMigrationComplete: false };
}

// Server-only raw snapshot for atomic write preparation, never a JSON response.
const prepareMemberWrite = (event, allowedIds) => resolveMemberSession(event, false, allowedIds);
// Caller must already have a verified admin cookie. Never expose raw records.
async function prepareAdminConsultWrite(memberId, allowedIds) {
  if (!boundedString(memberId, 256) || !allowedIds?.has(memberId)) return denied();
  const result = await readMembers();
  if (result.error) return result.error;
  const member = result.members.find(item => item.id === memberId);
  return member ? { ok: true, member } : denied();
}
module.exports = { authenticateMember, verifyMemberSession, clearMemberSessionCookie, auditMemberMigration, readMemberData, prepareMemberWrite, prepareAdminConsultWrite };
