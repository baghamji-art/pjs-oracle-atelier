'use strict';

async function readBoundedJson(response, maxBytes) {
  if (!response.body) throw new Error('UPSTREAM_BODY_MISSING');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('UPSTREAM_BODY_TOO_LARGE');
      }
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

module.exports = { readBoundedJson };
