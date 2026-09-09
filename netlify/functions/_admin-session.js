const crypto = require('crypto');

const COOKIE_NAME = 'pjo_admin_session';
const SESSION_SECONDS = 20 * 60;

function securityConfig() {
  const adminCode = process.env.ADMIN_MASTER_CODE || '';
  const sessionSecret = process.env.ADMIN_SESSION_SECRET || '';
  return {
    adminCode,
    sessionSecret,
    valid: adminCode.length >= 12 && adminCode.length <= 256 &&
      sessionSecret.length >= 32 && sessionSecret.length <= 1024
  };
}

function safeEqual(left, right) {
  const leftBuffer = crypto.createHash('sha256').update(String(left || '')).digest();
  const rightBuffer = crypto.createHash('sha256').update(String(right || '')).digest();
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function issueSessionCookie(secret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = encode({
    role: 'admin',
    iat: now,
    exp: now + SESSION_SECONDS,
    nonce: crypto.randomBytes(16).toString('base64url')
  });
  const token = payload + '.' + sign(payload, secret);
  return serializeCookie(token, SESSION_SECONDS);
}

function clearSessionCookie() {
  return serializeCookie('', 0);
}

function verifyAdminSession(event, secret) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 1024) return null;
  const header = event.headers?.cookie || event.headers?.Cookie || '';
  if (typeof header !== 'string' || header.length > 16384) return null;
  if (header.split(';').filter(pair => pair.trim().startsWith(COOKIE_NAME + '=')).length !== 1) return null;
  const cookies = parseCookies(header);
  const token = cookies[COOKIE_NAME] || '';
  if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !safeEqual(parts[1], sign(parts[0], secret))) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (!payload || payload.role !== 'admin' || !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) || payload.iat > now || payload.exp <= now ||
        payload.exp - payload.iat !== SESSION_SECONDS ||
        typeof payload.nonce !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(payload.nonce)) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders
    },
    body: statusCode === 204 ? '' : JSON.stringify(payload)
  };
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function serializeCookie(value, maxAge) {
  return [
    COOKIE_NAME + '=' + value,
    'Path=/.netlify/functions/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=' + maxAge
  ].join('; ');
}

function parseCookies(header) {
  return String(header || '').split(';').reduce((cookies, pair) => {
    const separator = pair.indexOf('=');
    if (separator < 0) return cookies;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (key) cookies[key] = value;
    return cookies;
  }, Object.create(null));
}

module.exports = {
  SESSION_SECONDS,
  clearSessionCookie,
  issueSessionCookie,
  json,
  safeEqual,
  securityConfig,
  verifyAdminSession
};
