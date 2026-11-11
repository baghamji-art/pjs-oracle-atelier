'use strict';
const crypto = require('node:crypto');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max;
const idValid = value => text(value, 256) && value.length > 0;
const fail = (status, code) => ({ ok: false, status, code });
const stringLimits = { q: 8192, type: 128, qtype: 128, group: 128, summary: 65536,
  summaryText: 65536, quick: 65536, fullSummary: 131072, readingHtml: 524288, cardsHtml: 131072 };
const fields = new Set([...Object.keys(stringLimits), 'score', 'favorite', 'cards', 'aiHybridReport', 'destinyReflection']);

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function revision(memberId, record) {
  const secret = process.env.MEMBER_SESSION_SECRET;
  if (!secret || secret.length < 32) throw Error('Archive revision not configured');
  return crypto.createHmac('sha256', secret).update('pjo-archive-v1\0')
    .update(canonical([memberId, record])).digest('base64url');
}

function validPatch(patch) {
  if (!object(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !fields.has(key))) return false;
  for (const [key, value] of Object.entries(patch)) {
    if (Object.hasOwn(stringLimits, key) && !text(value, stringLimits[key])) return false;
    if (key === 'score' && !(text(value, 256) || (typeof value === 'number' && Number.isFinite(value)))) return false;
    if (key === 'favorite' && typeof value !== 'boolean') return false;
    if (key === 'cards' && (!Array.isArray(value) || value.length > 10 || !value.every(card => text(card, 512)))) return false;
    if (key === 'aiHybridReport' && !text(value, 131072)) return false;
    if (key === 'destinyReflection' && (!object(value) || Object.keys(value).some(k => !['type', 'memo', 'time'].includes(k)) ||
      !text(value.type, 128) || !text(value.memo, 16384) || !Number.isSafeInteger(value.time) || value.time < 0)) return false;
  }
  return Buffer.byteLength(JSON.stringify(patch), 'utf8') <= 768 * 1024;
}

function validateCommand(command) {
  if (!object(command) || !['create', 'patch', 'delete'].includes(command.action) || !idValid(command.readingId)) return false;
  const allowed = command.action === 'create' ? ['action', 'readingId', 'record'] :
    command.action === 'patch' ? ['action', 'readingId', 'revision', 'patch'] : ['action', 'readingId', 'revision'];
  if (Object.keys(command).some(key => !allowed.includes(key))) return false;
  if (command.action === 'create') {
    if (!object(command.record) || command.record.id !== command.readingId ||
      !Number.isSafeInteger(command.record.time) || command.record.time < 0) return false;
    const { id, time, ...patch } = command.record;
    return typeof patch.q === 'string' && validPatch(patch);
  }
  return typeof command.revision === 'string' && /^[A-Za-z0-9_-]{43}$/.test(command.revision) &&
    (command.action !== 'patch' || validPatch(command.patch));
}

function prepareChange(member, command) {
  const history = member.history === undefined ? [] : member.history;
  if (!Array.isArray(history) || history.length > 10000) return fail(503, 'MEMBER_DATA_INVALID');
  const ids = new Set();
  for (const item of history) {
    if (!object(item) || !idValid(item.id) || ids.has(item.id)) return fail(503, 'MEMBER_DATA_INVALID');
    ids.add(item.id);
  }
  const previous = history.find(item => item.id === command.readingId) || null;
  if (command.action === 'create') {
    if (previous && canonical(previous) !== canonical(command.record)) return fail(409, 'ARCHIVE_CONFLICT');
    if (!previous && history.length >= 60) return fail(409, 'ARCHIVE_FULL');
    return { ok: true, previous: null, next: command.record };
  }
  // A repeated delete is safe; it never recreates or targets another record.
  if (!previous && command.action === 'delete') return { ok: true, previous: null, next: null };
  if (!previous) return fail(404, 'READING_NOT_FOUND');
  const expected = revision(member.id, previous);
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(command.revision))) return fail(409, 'ARCHIVE_CONFLICT');
  return { ok: true, previous, next: command.action === 'delete' ? null : { ...previous, ...command.patch } };
}

function authSnapshot(member) {
  return { ...Object.fromEntries(['id', 'status', 'paid', 'expiresAt', 'password', 'passwordHash']
    .map(key => [key, member[key] === undefined ? null : member[key]])),
    hasPasswordHash: Object.hasOwn(member, 'passwordHash') };
}

module.exports = { revision, validateCommand, prepareChange, authSnapshot };
