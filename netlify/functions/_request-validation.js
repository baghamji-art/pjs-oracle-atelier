'use strict';

function parseObjectBody(event, maxBytes) {
  const raw = event.body || '';
  if (typeof raw !== 'string' || raw.length > maxBytes * 2) return { error: 413 };
  const bytes = Buffer.from(raw, event.isBase64Encoded ? 'base64' : 'utf8');
  if (bytes.length > maxBytes) return { error: 413 };
  try {
    const body = JSON.parse(bytes.toString('utf8'));
    if (!isObject(body)) return { error: 400 };
    return { body };
  } catch (_) {
    return { error: 400 };
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateReading(body) {
  if (typeof body.question !== 'string' || !body.question.trim() ||
      typeof body.dbReport !== 'string' || !body.dbReport.trim()) return false;
  if (body.qtype !== undefined && typeof body.qtype !== 'string') return false;
  if (body.language !== undefined && !['ko', 'en', 'zh'].includes(body.language)) return false;
  if (body.userContext !== undefined && (!isObject(body.userContext) ||
      Buffer.byteLength(JSON.stringify(body.userContext), 'utf8') > 8192)) return false;
  if (!Array.isArray(body.cards) || body.cards.length !== 3) return false;
  return body.cards.every(card => isObject(card) &&
    typeof card.key === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(card.key) &&
    ['upright', 'reversed'].includes(card.orientation) &&
    ['nameKo', 'nameEn', 'position'].every(field => card[field] === undefined || typeof card[field] === 'string'));
}

module.exports = { parseObjectBody, validateReading };
