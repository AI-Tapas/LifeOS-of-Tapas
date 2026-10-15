# Cron reliability handoff

Implemented 15 October 2026 for review finding U3. Previously scan/brief routes inferred ownership from audit reads followed by separate inserts. Concurrent requests could both start; a known failed scan's recent start row blocked immediate retry.

## Changed behavior

`20261015000400_cron_claims.sql` adds `cron_runs` and service-only atomic claim/dispatch/finish RPCs. The unique owner/job/IST-date key serializes claims, and a fresh `run_id` fences each attempt. Audit start and terminal entries are in the same database transaction as their corresponding state changes. The table has owner-only read access; even service-role callers mutate through the RPCs rather than direct writes.

Both cron routes now claim before doing work. Known failures before brief dispatch, and caught scan failures, can retry immediately. Successful work remains deduplicated for that day. A failed result commit never reports success or makes the run automatically retryable.

The brief route durably records `uncertain` before contacting Gmail. A lost response, timeout, or failed final commit cannot authorize a second email. This conservative choice also blocks automatic retry after definite provider rejection; distinguishing safe provider rejection from uncertain delivery can be added after integration verification. No provider messages were sent during this work.

Interrupted running claims become `uncertain` after ten minutes; the implementation deliberately does not take over potentially active work. The 300-second scan and 60-second brief route limits remain unchanged. Existing daily successes are backfilled from audit history during migration, preventing a rollout from sending today's brief again. Any legacy success wins over concurrent legacy failures; ambiguous legacy starts/skips become uncertain.

## Recovery

An `uncertain` result is a reconciliation request, not permission to resend. Inspect the identified run and audit entries. For a brief, inspect provider Sent mail and any `provider_message_id`; mark the run successful only with delivery evidence. If an operator establishes that no provider dispatch occurred and the worker has stopped, an administrator may resolve the row to `failed` to permit a fresh attempt. Do not make that change just because a timeout elapsed. The application intentionally exposes no automatic reset/retry for uncertain outcomes; adding an owner reconciliation screen is future work.

Migration must be applied before deploying routes. This work did not deploy or migrate a live project.

## Regression evidence

- `node --test scripts/b24.test.ts`: 23 passed, including the originally failing model-401 immediate-retry case, concurrent requests, and failure to save final state.
- `node --test scripts/cron-brief.test.ts`: 5 passed against the real route with synthetic I/O, covering concurrent send exclusion, safe read-failure retry, uncertain provider response, failure to save success, and failed dispatch reservation.
- `scripts/cron-claims-sql.mjs`: migration and actual SQL checks for backfill, claims, fences, terminal states, dispatch reservation, expired runs, audit run IDs, RLS and grants. Run with `PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite/dist/index.js node scripts/cron-claims-sql.mjs`.
- The SQL proof used PGlite PostgreSQL 18.6 with minimal synthetic auth/audit tables. It does not verify the deployed PostgreSQL 17 Supabase stack, real concurrent connection lock scheduling, Vault, auth, or provider delivery.
- Targeted ESLint passed. Parent orchestration owns full repository compilation/integration checks and final consolidated results.

## Shared scan claim follow-up

Independent implementation review reproduced duplicate tasks when two different scan entrypoints ran together. Per-cron and per-MCP-job guards did not coordinate with direct MCP or owner UI scans. `20261015000500_scan_execution.sql` and `lib/assistant/scan-execution.ts` now wrap `runMailScan` itself with a single owner-wide durable claim. Every caller therefore shares the same exclusion boundary. A known completed or caught-failure scan releases its claim; a fenced token prevents a stale caller from releasing newer work. Lost release writes and abandoned claims refuse further execution pending reconciliation, including after the ten-minute window.

Authenticated callers can claim/release only their own user ID; service-role callers can operate on the owner resolved by trusted server code. No client receives a service credential. Apply both cron and scan-execution migrations before deploying routes.

Added behavioral tests prove that concurrent owner/service entrypoints create one task, rather than two with the same source ref; known failures release safely; claim storage errors, uncertain prior runs, and failed release block duplicate work. `scripts/scan-execution-sql.test.ts` additionally verifies actual SQL ownership, RLS, grants, stale-token fencing, and no expiry takeover using the full shared migration fixture. Run it with the repository's test dependencies installed, or the documented `PGLITE_MODULE_PATH` fixture override.
