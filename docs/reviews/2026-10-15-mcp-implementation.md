# MCP implementation notes for Claude

Implemented during the 15 October 2026 review follow-up. See the central review handoff and generated capability manifest for the complete change set.

## Boundaries and contracts

Both `/api/mcp` (shared-secret stdio adapter) and `/api/mcp/http` (OAuth Streamable HTTP) use `lib/mcp/dispatch.ts`. Discovery, tool calls, resources and prompts derive from the same capability-filtered manifest. The shared-secret adapter is deliberately a full-owner credential. OAuth connections use separately consented read/write, mail body, attachment, persona and finance capabilities. Explicit mailbox lists are enforced at tool dispatch; work-stream lists constrain task queries and versioned task/note preview commits in the database. Tools with joins that cannot honor a restricted selection are unavailable. Financial result fields are removed for connections without finance access, and financial mutation fields are rejected. Free text may naturally contain financial information; this is a record/field permission boundary, not semantic classification of arbitrary prose.

Mail scans need write, mail-body, attachment and finance capabilities because the existing scan pipeline includes ticket attachments and expense records. Jobs recheck current client approval/revocation and capabilities before execution. No new API approves external effects.

The remote endpoint rejects malformed envelopes, batches, oversized bodies, unsupported subsequent protocol versions and unapproved Origin headers. Initialization negotiates the advertised version. Notifications do not run tools or receive JSON-RPC replies. The stdio converter supports nullable unions, numeric/string/array constraints and strict nested objects; SDK round-trip tests cover structured operation IDs and schema rejection.

## Durable writes and recovery

Migration `20261015000300_mcp_operations.sql` introduces service-only operation, activity, job and preview writes with owner-readable RLS. Ordinary MCP calls record tool names and states, never arguments or message bodies, with a database-enforced 240 calls/minute/client budget and 256 KB result budget. Activities expire after 30 days, finished jobs after 30 days and previews after expiry plus one day. Cleanup runs on subsequent calls. Finished (completed or failed) operation records are pruned after 30 days; running and uncertain ones stay for review.

Writes accept `_idempotency_key`. The key is scoped to owner and client; changed input conflicts, identical input replays the durable result, and concurrent callers cannot both claim the key. Callers must reuse the same explicit key across timeouts. Without a caller-supplied key, a fresh invocation is a new operation. Operations created under different permissions cannot disclose their earlier results. Structured content preserves operation ID, action ID, state, undo availability, safe errors and provenance alongside readable text.

A process terminated after effects may leave an uncertain operation. Running intents older than ten minutes become uncertain on subsequent connector activity. Such operations and timed-out jobs are not automatically retried. Account recovery, real calendar sync timestamps, recent scan outcome timestamps and stuck/uncertain action metadata are exposed through `lifeos_health`. Provider delivery and database commits cannot be made one transaction.

## Jobs and versioned bulk edits

`lifeos_start_scan_job`, `job_status`, `job_cancel` and `job_results` use durable queued/running/terminal states. Next `after()` starts work after the response; `/api/cron/mcp-jobs` remains as a CRON_SECRET-protected route for manual triggering (it is not in `vercel.json`, because Hobby allows two crons). One queued/running MCP scan job exists per owner. The scan pipeline's separate shared owner mutex also covers direct and scheduled callers. Cancellation stops queued work or a worker that has not begun scanning; it does not undo completed effects or interrupt a provider/model call already underway. Progress reports real phases, not percentages.

Versioned preview tools intentionally support only task title/notes and note title/body text. The SQL commit locks the row, compares the entire original row version, checks the current work-stream restriction and commits the patch, audit and undo history together. No protected owner instruction, billing, priority or provider field is writable through this RPC. Undo snapshots contain only changed fields (`patch_only`), so reversing a text edit does not reset unrelated metadata. Up to ten previews may commit in one call: each item is atomic, the batch is not, and results explicitly identify partial failures. Committed preview IDs are idempotent.

Existing list APIs now return consistent pagination metadata and explicit live-offset/bounded-result consistency. These are **not immutable snapshots**: edits can move records across pages, so clients should deduplicate by ID. Provider-native continuation tokens and durable snapshot pagination remain future work; no stable cursor guarantee is advertised.

## Validation and limits

- `node --test scripts/mcp-contracts.test.ts`: malformed transport input, Origin/version negotiation, revocation, notifications, capabilities, finance redaction, idempotency conflict/replay and worker cancellation/revocation/uncertainty.
- `node --test scripts/mcp-operations-sql.test.ts`: actual migration SQL, one reservation per key, cross-client isolation, scoped preview commits, stale version rejection, transactional undo history, job cancellation/claims and expired worker uncertainty. Uses the repository's isolated PGlite fixture, not production Supabase scheduling.
- `npm run --prefix mcp-server build` and `node --test scripts/mcp-stdio.test.mjs`: actual compiled server with an SDK client against a synthetic HTTP backend, including nullable input and oversized bulk rejection. The separate central smoke command also covers the full manifest.

Real Supabase Auth/Vault, deployment scheduling, cross-process production races, and real provider mail/calendar effects still require staging validation with disposable test accounts. No external mail/calendar action was performed during these checks.
