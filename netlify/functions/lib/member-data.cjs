'use strict';
const { revision } = require('./archive-record.cjs');
// Explicit projections only. Never pass a raw member/log object to the browser.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => ({ ok: false, status: 503, code: 'MEMBER_DATA_INVALID' });
const success = data => ({ ok: true, status: 200, code: 'MEMBER_DATA_READY', data });
const TEXT_FIELDS = ['id', 'q', 'type', 'qtype', 'group', 'summary', 'summaryText', 'quick'];
const DETAIL_FIELDS = ['fullSummary', 'readingHtml', 'cardsHtml', 'aiHybridReport'];

function reading(record, detail) {
  const output = {};
  for (const key of [...TEXT_FIELDS, ...(detail ? DETAIL_FIELDS : [])]) {
    if (typeof record[key] === 'string') output[key] = record[key];
  }
  for (const key of ['time', 'score']) {
    if (typeof record[key] === 'number' && Number.isFinite(record[key])) output[key] = record[key];
  }
  if (typeof record.score === 'string') output.score = record.score;
  if (detail && object(record.destinyReflection)) {
    const { type, memo, time } = record.destinyReflection;
    if (typeof type === 'string' && typeof memo === 'string' && Number.isSafeInteger(time)) output.destinyReflection = { type, memo, time };
  }
  if (typeof record.favorite === 'boolean') output.favorite = record.favorite;
  if (Array.isArray(record.cards) && record.cards.every(card => typeof card === 'string')) output.cards = record.cards;
  // HTML is inert JSON here. A future renderer MUST use PJArchiveSecurity.restore.
  return output;
}

function projectMemberData(member, logs, resource, readingId) {
  if (resource === 'account') {
    const account = { type: 'member', id: member.id };
    for (const key of ['status', 'tier']) if (typeof member[key] === 'string') account[key] = member[key];
    for (const key of ['paid', 'permanent']) if (typeof member[key] === 'boolean') account[key] = member[key];
    if (member.expiresAt === null || Number.isSafeInteger(member.expiresAt)) account.expiresAt = member.expiresAt;
    return success(account);
  }
  if (resource === 'history' || resource === 'reading') {
    const history = member.history === undefined ? [] : member.history;
    if (!Array.isArray(history) || history.length > 10000) return fail();
    const ids = new Set();
    for (const item of history) {
      if (!object(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id)) return fail();
      ids.add(item.id);
    }
    if (resource === 'history') return success(history.map(item => ({ ...reading(item, false), revision: revision(member.id, item) })));
    const item = history.find(item => item.id === readingId);
    return item ? success({ ...reading(item, true), revision: revision(member.id, item) }) : { ok: false, status: 404, code: 'READING_NOT_FOUND' };
  }
  if (resource !== 'consultations' || !Array.isArray(logs)) return fail();
  const threads = new Map();
  for (const log of logs) {
    if (!object(log) || log.action !== 'Private consult message') continue;
    // Explicit userId wins. Never use a conflicting id as a second owner.
    const owner = log.userId || log.id;
    if (owner !== member.id) continue;
    if (typeof log.consultId !== 'string' || !log.consultId ||
        !['user', 'admin'].includes(log.role) || typeof log.message !== 'string' ||
        !Number.isSafeInteger(log.time) || log.time < 0) return fail();
    if (!threads.has(log.consultId)) threads.set(log.consultId, { id: log.consultId, messages: [] });
    threads.get(log.consultId).messages.push({ role: log.role, text: log.message, time: log.time,
      ...(typeof log.messageId === 'string' ? { messageId: log.messageId } : {}) });
  }
  const result = [...threads.values()];
  for (const thread of result) {
    thread.messages.sort((a, b) => a.time - b.time);
    thread.createdAt = thread.messages[0].time;
    thread.updatedAt = thread.messages.at(-1).time;
    thread.status = thread.messages.at(-1).role === 'admin' ? 'answered' : 'open';
  }
  return success(result.sort((a, b) => b.updatedAt - a.updatedAt));
}

module.exports = { projectMemberData };
