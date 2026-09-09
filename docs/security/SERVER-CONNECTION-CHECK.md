# Server connection checkpoint — 2026-09-09

Baseline: `6d86be5` (the user committed the prior security changes).
Backup: `/Users/pj7/Documents/Codex/2026-09-01/git/backups/security-server-check-kH1QaI/source.tar.gz`.

## Evidence provided by the user

Supabase screenshots show RLS enabled for app_state and tarot_love_cards_core,
and anon has SELECT/INSERT/UPDATE table privileges on both. Installed app_state
policies allow anon/authenticated SELECT, INSERT and UPDATE for id = main.
The card core table has a SELECT true policy only in the supplied policy results;
table write privileges alone do not bypass its RLS.
These are configuration findings, not evidence that a breach has occurred.

User reports adding SUPABASE_URL and SUPABASE_SECRET_KEY to Netlify.
Secret values were not requested, read, copied into code, or verified locally.

## Added endpoint

`GET /.netlify/functions/admin-security-check`

- Requires the existing valid, unexpired, signed administrator cookie BEFORE
  inspecting server Supabase configuration or requesting the database.
- Uses SUPABASE_URL and SUPABASE_SECRET_KEY exclusively in a Netlify Function.
- Sends the new sb_secret key in the apikey header (not a Bearer JWT).
- Accepts only the current project's exact HTTPS origin. Redirects are rejected.
- Issues a fixed GET selecting only id from app_state where id = main, limit 1.
- Does not accept a table, query, URL, member ID, or operation from the caller.
- Returns a status code, never a secret, database record or raw upstream error.
- Times out after 8 seconds, including response-body reading; does not cache results.
- No client HTML/CSS/JS, DB rows, policies or existing authentication changed here.

This endpoint prepares the next migration; it does NOT secure existing member
login, legacy direct Supabase access or the public LLM endpoint. In particular,
`dataAccessMigrationComplete: false` in its response is intentional.

## Verification

12 tests pass using fake keys and stubbed fetch, with zero real DB/OpenAI calls.
Coverage includes anonymous/expired/tampered/wrong-role requests, mutations,
missing configuration, wrong URLs/keys, error redaction, no forwarding of caller
parameters, empty/malformed data and response-body timeouts.

Run: `npm run test:security`.
No UI changes, so no new pixel comparison was performed for this checkpoint.

## Manual deployment checkpoint

1. In GitHub Desktop select the existing pjs-oracle-atelier repository.
2. Commit this checkpoint's files, then Push origin (unless already pushed).
3. Wait for the linked Netlify production deploy to report Published.
4. In the same browser open the deployed HTTPS /admin.html and log in normally.
   A file:/// local page cannot test Netlify Functions or Secure cookies.
5. Keeping the exact same hostname, navigate to:
   /.netlify/functions/admin-security-check
6. Expected JSON: ok=true, code=SERVER_CONNECTION_READY, mode=read-only,
   dataAccessMigrationComplete=false. The JSON response contains no key or member data.

Error codes:
- ADMIN_LOGIN_REQUIRED (401): log into /admin.html on the same hostname again;
  the existing cookie expires after 20 minutes.
- ADMIN_SECURITY_NOT_CONFIGURED (503): check existing admin environment settings.
- SUPABASE_SERVER_CONFIG_MISSING (503): check Production values, Functions scope,
  and that a new deploy occurred after adding variables.
- SUPABASE_PROJECT_URL_INVALID (503): check the URL matches the current project,
  without extra paths, query, credentials or a different project host.
- SUPABASE_SECRET_KEY_INVALID (503): use the sb_secret key, not publishable/legacy.
- SUPABASE_ACCESS_DENIED (502): check key/project match and table access, without
  sharing the key. Do not change existing policies to work around this error.
- APP_STATE_MAIN_NOT_FOUND (409): investigate; do not initialize/overwrite the table.
- SUPABASE_PROBE_FAILED / SUPABASE_RESPONSE_INVALID (502), or SUPABASE_PROBE_TIMEOUT
  (504): report the code and inspect the service/configuration safely.

Do NOT revoke current app_state access yet. Coordinate the subsequent authenticated
data path and verified database backup before the permission cutover. Local source
backups above are not backups of the production database.
