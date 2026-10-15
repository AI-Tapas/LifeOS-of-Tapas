# Claude handoff: security, usability and MCP implementation

Date: 15 October 2026 IST. Baseline: `feb41ac850b52e388d50377089847864797a1d06` on main.

The owner asked Codex to implement the review findings and MCP recommendations, then explicitly requested agents with Codex acting as reviewer/orchestrator. The owner subsequently requested committing and pushing the implementation to GitHub; the publication branch is `codex/security-usability-mcp-review`. No production migration, deployment, email/invitation/cancellation was performed during implementation or validation.

Read this document before continuing work. The [historical review](reviews/2026-10-15-security-usability-mcp.md) records the original findings; it does not describe current behavior. The earlier nullable-schema finding was withdrawn because no original tool used that schema form. The new operational tools do use nullable types, and the stdio converter now supports them explicitly.

## Changes tied to findings

| Review item | Implemented change | Main code |
|---|---|---|
| S1: mail subject/header injection | Validate headers and addresses at proposal and send, encode Unicode subjects and body correctly, preserve approved recipient boundaries. | `lib/assistant/mail-headers.ts`, `execute.ts` |
| S2: guest-event approval gap | Read current provider guests and version, require confirmation for guest changes, use If-Match, preserve omitted attendees; owner calendar UI confirms guest effects. MCP solo paths refuse guests. | `lib/events/write.ts`, calendar actions/UI |
| S3: OAuth races and false Disconnect | Transactional client/grant locking, one-time consumption, refresh-family replay revocation, durable client tombstones, checked disconnect/audit. Active approved client required during authorization. | OAuth routes, migration 002 |
| S4: misleading consent | Shared capability descriptions, explicit read/write/mail/attachment/persona/finance choices and mailbox/work-stream selection. Server dispatch enforces grants and filters discovery. | `lib/mcp/permissions.ts`, Connect and Settings |
| S5: private offline copies | Private HTML and RSC are no longer cached. Retain public offline screen/assets; clear legacy caches and signal other tabs on sign-out. | `public/sw.js`, browser-session helper, sign-out/register components |
| S6: open login redirect | Shared same-origin path validation at login and callback. | `lib/auth/safe-redirect.ts` |
| S7: malformed RPC/registration | Bounded streaming JSON reads, envelope/schema validation, protocol errors; public registration quotas and expiry in SQL. | MCP/OAuth HTTP helpers and routes |
| S8: dependency/build maintenance | Patched target versions and repaired lockfiles; original fonts self-hosted with licenses/checksums. **Clean target installation still blocked by registry 503.** | package manifests/locks, `app/fonts`, layout |
| R1: false/permanent undone state | Claim Undo separately, mark undone only after checked success; safe single-write failures release claims; ambiguous multi-step/provider failures stay visible for reconciliation. | `execute.ts`, migration 001, History UI |
| R2: missing action history/final state | Persist autonomous intent before effects; preserve action IDs and explicit uncertainty if final persistence fails. Never blindly replay ambiguous provider effects. | `execute.ts`, `core.ts`, History UI |
| U1/U2: keyboard/semantics/contrast | Native modal dialog behavior, focus restoration, dirty dismissal handling; calendar lists, keyboard scrolling and contrast corrections. | shared UI, calendar/trips/nav |
| U3: scan retry and cron races | Atomic claims and fenced completion, immediate retry after known failure, no automatic takeover of ambiguous work; brief records dispatch uncertainty before sending. | cron routes/helpers, migration 004 |
| U4: recovery/docs | Expired-link explanation, honest outage errors/live announcements; generated MCP docs and current transport/permission instructions. | Login, README, MCP README, generated reference |

## MCP additions and deliberate boundaries

Both `/api/mcp` (legacy shared-secret adapter) and `/api/mcp/http` (OAuth Streamable HTTP) use the shared dispatcher. The compiled stdio server retains structured results and operation IDs instead of returning only prose.

- **Capabilities:** read-only by default for newly consented OAuth connections, with explicit sensitive disclosures. Unsupported combinations fail closed. Narrow selections can make aggregate/legacy tools unavailable; the connector does not substitute unfiltered data.
- **Operations/idempotency:** writes accept `_idempotency_key`, retain operation state/result, and expose status. Reuse keys only for identical arguments. Scope changes must not reveal a prior broader result. Without a client-supplied key, a lost-response retry is a new operation.
- **Versioned previews/bulk:** preview and commit task title/note or saved-note title/body changes. Each record comparison, mutation and history entry is transactional. At most ten previews per commit; the batch can partially succeed and reports each result. This is not a version guard on every legacy write or on every Undo.
- **Background scans:** start/status/results/cancel, durable claims, actual phase reporting, and current-permission rechecks. Cancellation cannot reverse work already performed. Next `after()` starts a worker promptly. There is no scheduled recovery cron (Vercel Hobby allows only two); the protected `/api/cron/mcp-jobs` route remains for manual or external triggering, so jobs rely on `after()` and a lost worker needs inspection.
- **Health/activity:** connection-scoped activity without private arguments/bodies, safe recovery links and permitted account/action health. Settings also shows owner-readable recent calls, scan jobs and operations needing review. Request/result budgets are enforced. Stuck/uncertain work needs inspection, not automatic retry.
- **Resources/prompts:** authorized context/task/calendar/trip/unbilled/health resources; daily planning, trip readiness and unbilled-work prompts. Reads go through the same dispatcher. Imported text stays untrusted data.
- **Contracts/docs:** structured output schemas, explicit errors, result-size limits, pagination metadata, and converter support for nullable unions and constraints. Offset pagination is live, not a stable snapshot; deduplicate IDs across concurrently edited pages.

See [generated capabilities](generated/mcp-capabilities.md) for actual names/counts. Run `npm run docs:mcp` when the registry changes.

The legacy `LIFEOS_MCP_TOKEN` is an owner-configured full-access secret. All users of that secret share one connection/activity/idempotency namespace. Use separate OAuth connections for individual client permissions and revocation. No remote tool can approve sends. Private transcripts, provider credentials and protected owner instruction/billing fields remain outside the tool surface.

## Migration and rollout requirements

Apply reviewed migrations before exposing the new app routes:

1. `20261015000100_execution_safety.sql`: durable action state and separate Undo claim.
2. `20261015000200_oauth_security.sql`: capabilities, client/grant lifecycle RPCs and replay revocation.
3. `20261015000300_mcp_operations.sql`: operations, scoped activity, scan jobs and versioned previews.
4. `20261015000400_cron_claims.sql`: atomic cron runs, legacy audit backfill and dispatch fencing.
5. `20261015000500_scan_execution.sql`: one fenced owner scan across UI, cron, direct MCP and background jobs.

**OAuth migration keeps live connections (changed in B37, see Follow-ups).** Clients with a live access or refresh grant stay approved with their existing access; only dead clients and in-flight codes are revoked.

The cron migration backfills existing audit evidence so deploying cannot resend a brief already sent today. Expired/ambiguous work becomes uncertain. Do not simply delete run rows or clear execution claims: first inspect provider/local effects, then perform a reviewed repair. See [cron recovery notes](reviews/cron-reliability.md).

Generated database types were updated by hand against the migrations because the full local Supabase stack was unavailable. Regenerate with `npm run db:types` in a working local stack and review the diff. Do not apply schema changes through the dashboard or run destructive reset against production.

Independent integration review also reproduced duplicate task creation when the cron, direct MCP and background scan entry points ran simultaneously. The shared scan claim now lives at `runMailScan`, covering every entry point. Expired claims become uncertain and require review; a transport-specific job lock alone was insufficient.

## Verification and remaining release checks

Final combined results are recorded below. Focused suites cover actual executor/route bodies with intercepted providers, SQL policies/RPCs in PGlite, browser keyboard/contrast/cache behavior, and SDK transport contracts.

Important limits:

- PGlite runs PostgreSQL 18.6 with synthetic Auth/Vault, while deployment targets PostgreSQL 17. It validates SQL behavior but not Supabase Auth/Vault, real independent-session scheduling, or hosted privileges. Run the real integration RLS suite on a separate development Supabase project.
- Registry HTTP 503 prevented clean installation/audit of the upgraded target dependencies. Installed test runtime remains Next 16.2.10, React 19.2.4 and MCP SDK 1.30.0. Target locks specify Next 16.4.1, React 19.3.1 and SDK 1.32.1. A successful build with installed dependencies is not patched-runtime validation.
- No live Google/Microsoft account, passkey/OTP flow or authenticated private-cache journey was exercised. Provider calls were intercepted. Verify guest changes, ETags, sending, revoked accounts and uncertain-outcome recovery with disposable accounts before release.
- Undo failure/state handling is fixed, but legacy snapshot-based inverses do not generally carry a post-write version check. An old Undo may conflict with later owner edits. Inspect current state before using old history; extending atomic version protection to every inverse remains separate work.
- The new offline privacy policy deliberately removes private offline reading. Public offline guidance remains available. Validate installed-PWA upgrade and multiple tabs with the owner.

Run in a working registry environment:

```sh
npm ci
npm --prefix mcp-server ci
npm audit --omit=dev
npm --prefix mcp-server audit --omit=dev
npm run lint
npx tsc --noEmit --incremental false
npm test
npm run test:review:sql
npm run docs:mcp
npm run test:mcp:stdio
npm run build
npm --prefix mcp-server run build
```

Browser tooling and invocation are documented in `scripts/review-ui-browser.cjs`; it uses optional Playwright/axe tooling, Chromium, and the development preview route. Browser fixtures and synthetic SQL roles must never be mistaken for production integration coverage.

## Area notes

- [MCP contracts, jobs, scopes and limits](reviews/2026-10-15-mcp-implementation.md)
- [OAuth changes and SQL validation](reviews/2026-10-15-oauth-security.md)
- [UI/privacy changes](reviews/ui-privacy-changes-2026-10-15.md)
- [Cron design and recovery](reviews/cron-reliability.md)
- [Dependency targets, fonts, and network blocker](reviews/2026-10-15-dependency-maintenance.md)

## Final integration results

| Check | Final outcome |
|---|---|
| `npm test` | 788 passed, zero failed or skipped. |
| `npm run test:review:sql` | 13 passed, plus the standalone cron migration/claim/RLS suite passed. The complete fixture applies all 36 repository migrations, including the five new migrations. PGlite uses synthetic Auth/Vault and does not establish real multi-session race behavior. |
| `npm run lint` | Passed. |
| `npx tsc --noEmit --incremental false` | Passed. |
| `npm run build` | Passed with local placeholder Supabase configuration and the existing installed dependencies. No credentials or provider calls were required. |
| `npm run test:mcp:stdio` | Generated the 76-tool manifest, compiled stdio, passed SDK initialization, structured read/write IDs, resources/prompts, nullable schemas and bulk-size rejection checks against a synthetic HTTP fixture. |
| Browser regression script | Passed modal keyboard/focus/dirty-dismissal checks; contrast, semantics and overflow at 320/390/1280px in both themes; cross-tab sign-out, public-only offline navigation, expired-link recovery and outage feedback. |
| Target dependency lock consistency | Both `npm ci --dry-run --offline` checks passed. Actual clean target installation and fresh audits remain blocked by registry HTTP 503. |

Build and SDK success refer to the installed versions listed above, not the upgraded target runtime. No production database or deployment was changed. The five migrations, OAuth re-consent, clean dependency installation and real provider/Supabase integration checks remain release steps.

## Follow-ups (B37)

Applied on branch `codex-followups` after the Codex review:

1. **Lockfile:** `package-lock.json` regenerated from the registry; `npm ci` and `npm --prefix mcp-server ci` succeed.
2. **Crons:** `/api/cron/mcp-jobs` removed from `vercel.json` (Hobby allows two). The route stays, protected by CRON_SECRET, and both MCP routes still start the worker with `after()`. A worker lost to an infrastructure failure now needs inspection or a manual trigger.
3. **Scan lock:** `claim_scan_execution` takes over an `uncertain` or expired `running` claim once it is over 2 hours old, writing an audit row `scan_claim_taken_over`. A failed release after a successful scan is logged and the scan result is returned. `mcp_jobs` and `cron_runs` have no permanent dead end: a stale job becomes `uncertain` and does not block new jobs, and a stuck cron run only affects its own IST day. SQL tests added.
4. **OAuth migration, route A (legacy grants kept):** clients with at least one live access or refresh grant become approved with no registration expiry and full capabilities (what they could do before, so no new access); their live grants stay valid. Capabilities live on the client row, and refresh rotation and replay detection work on legacy grants (tested), so keeping them is safe. Codes in flight and grants of clients with nothing live are revoked. An audit row `mcp_connection_kept_on_migration` is written per kept client.
5. **Consent page:** every capability is ticked by default, with "All" mailboxes and work streams, plus a note that anything can be unticked. Server-side defaults for registrations without a choice stay read-only.
6. **Retention:** `begin_call` also prunes completed and failed `mcp_operations` older than 30 days; running and uncertain rows stay for review.
7. **Rate limit:** 240 calls a minute per client (was 60).

New rollout steps: apply the five migrations in order as before. No re-consent or re-registration is needed for connections that were live. Clients that were already dead must reconnect. Check Settings afterwards: kept connections show as connected, and you can narrow their permissions there.
