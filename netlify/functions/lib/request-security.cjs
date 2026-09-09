'use strict';

function header(event, name) {
  const entry = Object.entries(event?.headers || {}).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === 'string' ? entry[1] : '';
}

function trustedOrigins() {
  const origins = new Set(['https://pjtarot.netlify.app']);
  // These are server environment values, never Host/X-Forwarded-Host supplied by a caller.
  for (const value of [process.env.URL, process.env.DEPLOY_URL, process.env.DEPLOY_PRIME_URL]) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password &&
          url.pathname === '/' && !url.search && !url.hash) origins.add(url.origin);
    } catch (_) {}
  }
  if (process.env.NETLIFY_DEV === 'true') {
    origins.add('http://localhost:8888');
    origins.add('http://127.0.0.1:8888');
  }
  return origins;
}

function validateBrowserMutation(event) {
  // CSRF/browser-origin protection, NOT authentication. Non-browser callers can
  // forge Origin; member auth and distributed quotas remain separate requirements.
  const origin = header(event, 'origin');
  if (!trustedOrigins().has(origin) || header(event, 'sec-fetch-site') === 'cross-site') {
    return { status: 403, error: 'Request origin is not allowed' };
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(event, 'content-type').trim())) {
    return { status: 415, error: 'Content-Type must be application/json' };
  }
  return null;
}

module.exports = { validateBrowserMutation };
