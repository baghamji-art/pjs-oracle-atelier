'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
// Fixed, versioned cost: never accept work factors supplied by a DB record.
// OWASP scrypt profile: N=2^15, r=8, p=3 (32 MiB plus overhead).
const PREFIX = 'pjo-scrypt-v1$';
const OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const validPassword = value => typeof value === 'string' && value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= 4096;

function parseHash(value) {
  if (typeof value !== 'string' || !/^pjo-scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(value)) return null;
  const [, salt, digest] = value.split('$');
  return { salt: Buffer.from(salt, 'hex'), digest: Buffer.from(digest, 'hex') };
}

async function hashPassword(password) {
  if (!validPassword(password)) throw new TypeError('Invalid password format');
  const salt = crypto.randomBytes(16);
  const digest = await scrypt(password, salt, 64, OPTIONS);
  return PREFIX + salt.toString('hex') + '$' + digest.toString('hex');
}

function hasValidCredential(member) {
  if (!member || typeof member !== 'object') return false;
  // A malformed/new hash must NEVER silently downgrade to the old password.
  return Object.hasOwn(member, 'passwordHash') ? !!parseHash(member.passwordHash) : validPassword(member.password);
}

async function verifyPassword(password, member) {
  if (!validPassword(password)) return false;
  if (member && Object.hasOwn(member, 'passwordHash')) {
    const parsed = parseHash(member.passwordHash);
    if (!parsed) return false;
    const digest = await scrypt(password, parsed.salt, 64, OPTIONS);
    return crypto.timingSafeEqual(digest, parsed.digest);
  }
  const stored = validPassword(member?.password) ? member.password : '';
  const digest = text => crypto.createHash('sha256').update(text).digest();
  // Compatibility only; new credentials must use hashPassword at cutover.
  return crypto.timingSafeEqual(digest(password), digest(stored));
}

module.exports = { hashPassword, verifyPassword, hasValidCredential };
