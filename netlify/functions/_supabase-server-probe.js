'use strict';

// Server-only, fixed read-only probe. Never return/log credentials or DB records.
// Deliberately no generic table/path/query proxy and no mutation methods.
const PROJECT_ORIGIN = 'https://chffnolrtxfoehegnecj.supabase.co';

function readServerConfig() {
  const value = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SECRET_KEY || '';
  if (!value || !key) return { error: 'SUPABASE_SERVER_CONFIG_MISSING' };
  try {
    const url = new URL(value);
    if (url.origin !== PROJECT_ORIGIN || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) {
      return { error: 'SUPABASE_PROJECT_URL_INVALID' };
    }
    if (key.length > 1024 || !/^sb_secret_[A-Za-z0-9_-]{16,}$/.test(key)) {
      return { error: 'SUPABASE_SECRET_KEY_INVALID' };
    }
    return { origin: url.origin, key };
  } catch (_) {
    return { error: 'SUPABASE_PROJECT_URL_INVALID' };
  }
}

async function probeAppState() {
  const config = readServerConfig();
  if (config.error) return { status: 503, code: config.error };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // Only id is requested. No members, passwords, messages, logs or stored readings.
    const response = await fetch(config.origin + '/rest/v1/app_state?select=id&id=eq.main&limit=1', {
      method: 'GET',
      headers: { apikey: config.key, Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal
    });
    if (!response.ok) {
      // Do not read, echo or log upstream error bodies (they can contain secrets/data).
      const code = [401, 403].includes(response.status) ? 'SUPABASE_ACCESS_DENIED' : 'SUPABASE_PROBE_FAILED';
      return { status: 502, code };
    }
    const data = await response.json();
    if (!Array.isArray(data) || data.length > 1 || (data[0] && data[0].id !== 'main')) {
      return { status: 502, code: 'SUPABASE_RESPONSE_INVALID' };
    }
    if (!data.length) return { status: 409, code: 'APP_STATE_MAIN_NOT_FOUND' };
    return { status: 200, code: 'SERVER_CONNECTION_READY' };
  } catch (error) {
    return { status: error?.name === 'AbortError' ? 504 : 502,
      code: error?.name === 'AbortError' ? 'SUPABASE_PROBE_TIMEOUT' : 'SUPABASE_PROBE_FAILED' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { probeAppState, readServerConfig };
