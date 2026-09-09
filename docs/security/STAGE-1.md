# Critical security work — stage 1 (2026-09-09)

## Status

Local changes only. Not committed, pushed, or deployed. Production is NOT yet secure.
Current UI/CSS, tarot text, database schema and production settings were not changed.

Backup: `/Users/pj7/Documents/Codex/2026-09-01/git/backups/critical-stage1-4hM5Is/source.tar.gz`
Baseline Git commit: `c522f2c`.

## Implemented

1. All three HTML entry points load pinned local DOMPurify 3.4.15 and archive-security.js.
2. Persisted cardsHtml/readingHtml are sanitized into DOM fragments before insertion.
   Inline event handlers, executable URLs and active document/embedding tags are removed.
   Live renderers and stored originals remain untouched. Missing sanitizer fails closed.
   Class names, IDs, data attributes, inline styling and normal reading controls remain
   available (the sanitizer may normalize insignificant attribute whitespace).
3. Shared server input validation handles null, arrays, malformed JSON, base64 bodies,
   byte-size limits, three-card structure and directions without uncaught TypeErrors.
4. Admin login rejects malformed code fields rather than coercing/truncating objects.

## Remaining Critical work — do not consider these resolved

- C1: actual Supabase RLS/grants must be audited; browser-wide app_state access remains.
- C2: member passwords/session restoration and admin data authorization still need a
  coordinated server-authentication migration. The existing login UI is unchanged.
- C3: stored-HTML script execution is mitigated at the identified archive restoration
  sink, not an assertion that every site-wide HTML sink is safe. Declarative data-action
  attributes remain for existing controls; their handlers still need server authorization.
- C4: unauthenticated LLM calls, missing quotas/rate limits and cost controls remain.
  Input validation is NOT authentication, billing protection or a rate limiter.

Never close production app_state permissions before the compatible authenticated
data path is ready and tested. Do not send production secrets in chat.

## Verification

- `npm run test:security`: 4 test groups passed, using a stubbed OpenAI fetch (zero paid calls).
- `npm run test:security:fixture`: loopback-only synthetic fixture. App browser tests passed
  at widths 390 and 1280. User/admin entry DOM, geometry and computed styles match baseline.
  Career, dating_possibility and past_life_connection result snapshots retain DOM,
  geometry and computed styles through sanitization. Story Next keeps details open.
  Malicious HTML probes were removed, no attack executed, checkbox state survived,
  and sanitizer absence preserved the current DOM without inserting raw HTML.
- This is NOT an actual iPhone Safari test or a screenshot pixel-diff certification.
  Standalone Playwright launch was blocked by the host macOS sandbox; an optional
  headless screenshot test remains in tests/archive-security.browser.cjs for other hosts.
- `git diff --check` passes. CSS and tarot asset files are unchanged.
- Fixtures disable cloud access and LLM calls. Production DB rows were not queried.

## Next manual checkpoint

Open the correct project in Supabase → SQL Editor → New query.
Run `docs/security/read-only-supabase-audit.sql` (SELECT statements only).
Share all three result tables or screenshots, not table data or API keys.
The next implementation should be based on actual policies/grants and a confirmed
backup, then prepare the server-authenticated transition and deployment sequence.

## Deployment and rollback

These archive/input changes require no new environment variables or SQL changes.
If deploying this stage, include all three HTML files, both new browser security files,
the vendor file, both modified handlers, and _request-validation.js in the same deploy.
Do not deploy only the HTML references. Netlify publishes outputs; tests/docs remain outside.
Revert only this stage's changes after checking newer work, or select the prior Netlify
deploy for rollback. Do not overwrite subsequent user edits with the backup wholesale.
