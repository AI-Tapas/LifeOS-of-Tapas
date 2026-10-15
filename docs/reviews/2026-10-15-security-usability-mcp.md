> Historical review before implementation. For current status, see [Claude handoff](../CLAUDE_HANDOFF_2026-10-15.md).

# Life OS: deeper security, usability and MCP review

Reviewed 14 October 2026 UTC / 15 October IST. Repository: `AI-Tapas/LifeOS-of-Tapas`, main at `feb41ac850b52e388d50377089847864797a1d06`.

This is the fresh review requested after the user selected GPT 6 Astra. One agent performed it; no subagents were used. Application source and tracked configuration were not changed. Reproductions and logs are outside the checkout in this directory. This report supersedes the earlier report where explicitly corrected below.

## Assessment

The application has useful safeguards: separate autonomous and approval-required tools, PKCE, hashed credentials, approval payload binding, owner-scoped database policies, and explicit transcript restrictions. The interface is readable on narrow screens, and the MCP exposes **26 read tools and 41 write tools**.

However, the approval and connection-management promises are not consistently enforced. Fix the mail-header injection, guest-event approval gap, OAuth lifecycle, and misleading consent before expanding access to sensitive accounts. Undo and action-history failures also undermine the promise that autonomous work is visible and reversible.

No production exploitation was attempted. Provider requests were intercepted; no email, invitation or cancellation was sent.

## Tested scope and limitations

| Layer | Result | Limits |
|---|---|---|
| `node --test scripts/*.test.ts` | **724 tests: 722 pass, 2 fail**, no skips | Many are pure, mocked or source-based. Separate `rls.test.mjs` integration tests are not included. |
| TypeScript, ESLint | Both pass | Installed dependencies used the workaround described below. |
| MCP build | Pass | This is the stdio package build, not the production Next build. |
| SDK-to-stdio smoke test | Compiled server initializes, lists all 67 actual tools and handles read/write adapter calls | Isolated HTTP fixture, not an authenticated Life OS backend. |
| Executor/OAuth probes | Actual modules tested under failure injection and deterministic interleavings | Database and provider dependencies replaced; no live provider delivery claims. |
| SQL | **31 migrations** applied; policy and trigger checks executed | PGlite PostgreSQL **18.6**, synthetic auth claims/default grants and Vault fixture. Repository targets PostgreSQL 17. Not Supabase Auth/Vault or production privilege validation. |
| Browser | Real preview components at 320, 390, 1280 pixels; axe and keyboard checks | Fixture data, not a signed-in account. No page overflow or browser page errors. |
| Offline | Actual worker serves cached fixture after cookies are cleared and network disabled | Authenticated Sign out end-to-end remains untested. |
| Dependencies | Same-session earlier audit retained and reviewed | Not a new registry audit or proof all advisory paths are reachable. |

Full Supabase startup remains blocked: Docker's `vfs` driver ran out of space expanding the PostgreSQL image. Account/service credentials are absent. The earlier production build was blocked by Google Font network access; this pass did not establish a successful production build. Root `npm ci` fails lockfile consistency checks, so dependencies were installed with `npm install --package-lock=false`. This is a useful review environment, not a fully validated, reproducible deployment environment.

## Security findings

### S1 - High: an approved subject can add a mail recipient header

**Code:** `lib/assistant/execute.ts:395,2066,2089`.

The Gmail path interpolates the subject directly into raw MIME. A subject containing `Routine update\r\nBcc: extra@example.test` creates a separate Bcc header, although the approved recipient array contains only `approved@example.test`. The queue renders subject text and recipient arrays, so approving the structured payload does not ensure the transport recipient set matches those arrays.

**Evidence:** `executor-probes.cjs` queues the actual action, verifies no provider call occurs before approval, approves it, intercepts the Gmail request and decodes MIME containing the added Bcc header. This proves request header injection; Gmail delivery was not tested. Exploitation requires influence over a proposed subject and subsequent owner approval, not anonymous approval-free sending.

**Fix:** reject CR/LF and prohibited controls in all header values; validate addresses structurally; use a correct MIME encoder. Bind approval to normalized recipients and content. Acceptance tests should compare approved recipients with decoded transport recipients and cover Unicode subjects.

### S2 - High: guest-bearing calendar events can be deleted autonomously

**Code:** `lib/assistant/execute.ts:1298,1354`; `lib/events/write.ts:169,229`.

`delete_event` verifies `source = app`, but approved invitations also create app events. It never establishes that the existing event has no guests. `update_event_solo` checks attendee keys in the new input, not the existing event's guests.

**Evidence:** `boundary-probes.cjs` seeds an app-created Microsoft event containing a guest. The actual executor immediately dispatches a Graph DELETE without queueing or owner approval. The request was intercepted; cancellation delivery was not tested. The edit variant is source-reviewed: an omitted attendees field does not establish that a provider event is solo. Its local upsert also writes `attendees: null` when attendees are omitted, obscuring that distinction.

**Fix:** classify existing event state, require approval for changes/deletion affecting guests, and recheck provider state at execution. Preserve omitted attendee metadata. Label irreversible deletion explicitly: this operation currently has no inverse. Test previously approved meetings and events whose attendees change after proposal. New events explicitly carrying attendees already require confirmation; preserve that control.

### S3 - High: OAuth rotation and Disconnect are not atomic or failure-aware

**Code:** `app/api/mcp/oauth/token/route.ts:50-94`; `app/(app)/connect/actions.ts:24`; `app/api/mcp/http/route.ts:61`.

Three related failures were reproduced:

1. Code exchange/refresh separately read, check, update and issue. Updates are not conditional on the credential still being unused/unrevoked, and errors are ignored. Concurrent requests both issue token pairs.
2. Refresh can read before Disconnect and issue new grants after Disconnect revokes grants and deletes the registration. Access authorization does not require an active registration. SQL checks confirm registration deletion does not cascade to grants.
3. A returned database error during grant revocation is ignored. Disconnect reports success and deletes the visible registration while credentials remain usable.

**Evidence:** deterministic mocked interleavings in `boundary-probes.cjs`; the earlier actual-route authorization-code probe was also rerun and again issued two pairs. Already-revoked credentials are correctly rejected if revocation precedes the request. These failures require valid credentials/in-flight requests; they do not mint credentials from nothing.

**Fix:** transact grant consumption/rotation, check compare-and-set results, detect refresh-family replay, and keep a durable client revocation state checked during issuance and authorization. Disconnect must fail visibly unless revocation commits. Test one winner under parallel exchange and no surviving credential after concurrent disconnect.

### S4 - High privacy impact: consent contradicts actual MCP access

**Code:** `app/(app)/connect/page.tsx:84-94`; `lib/assistant/mcp-api.ts:526-559`; `lib/mcp/oauth-core.ts:20`.

Consent says the connection cannot read the persona or accounts. `lifeos_get_house_rules` deliberately loads the active persona, audits disclosure and returns its house rules. Other tools expose mailbox/attachment content, finance and trip data, and destructive private-record operations beyond the consent's short list. Connections all receive the same `lifeos` scope.

This is misleading consent, not a claim that persona reading violates later product requirements: those explicitly added the tool. Account metadata is distinct from OAuth secrets; this review did not establish disclosure of provider secrets.

**Fix:** immediately correct consent from the actual disclosure registry. Add selectable per-connection capabilities, enforced server-side and visible in settings. Acceptance: every enabled disclosure class is described, and excluded capabilities cannot be used through either transport.

### S5 - High on shared devices: offline pages survive credential removal

**Code:** `public/sw.js:55-85`; `components/sign-out-button.tsx:9`.

The worker caches successful navigation HTML and RSC responses in an origin-wide cache. Sign out clears authentication and redirects without purging private caches or partitioning them by session.

**Evidence:** the actual worker cached the preview page; after all cookies were cleared and networking disabled, the page remained readable. This proves cache persistence independent of cookies. Its private-data impact follows from general page caching and logout code; a real signed-in logout was not tested.

**Fix:** define the private offline-data policy, purge sensitive HTML/RSC and app state on logout, and prevent asynchronous in-flight cache writes from restoring private entries afterward. Test multiple tabs and browser restart; consider opt-in private offline storage.

### S6 - Medium: successful magic-link login accepts an external redirect

**Code:** `app/auth/confirm/route.ts:11,20`.

The callback passes `next` directly to `redirect()` after verification. A probe with verification mocked successful selected `https://example.test/`. This can misdirect a user after genuine login; it does not itself prove session-token disclosure or authentication bypass.

**Fix:** validate the resolved destination against the app origin with a shared helper; test absolute, protocol-relative and backslash-normalized external destinations alongside legitimate internal paths.

### S7 - Medium robustness: malformed requests throw; registration needs abuse controls

**Code:** `app/api/mcp/http/route.ts:104,153`; `app/api/mcp/oauth/register/route.ts:29`.

Authenticated `null` and `[null]` RPC envelopes throw uncaught TypeErrors. Public registration also throws for JSON null, scalar `redirect_uris` and numeric `client_name`. Every valid registration persists a client; the reviewed handler has no rate limit, expiry or quota. Open registration is intentional, but persistent unrestricted writes create an abuse surface. Platform limits were not inspected and no load/DoS test was run.

**Fix:** validate shapes, bound body/URI sizes and counts, return protocol errors, rate-limit registration and expire unapproved clients. Add conformance tests for protocol negotiation, notifications and malformed requests against the advertised MCP version.

### S8 - Dependency maintenance: high priority, applicability varies

Earlier production audit: six affected package entries, including one critical and four high. MCP audit: six entries, including one critical and two high. These are package counts, not proven independent exploits.

Next.js is pinned to **16.2.10**. Recorded advisories include Server Actions/proxy issues and conditional Windows/image-processing paths. The MCP SDK advisory concerns OAuth-client behavior, while this package is a stdio server; presence alone does not demonstrate reachability. Similar caution applies to proxy/Express transitives.

Review prerequisites, upgrade to supported patched versions, regenerate consistent lockfiles and validate production builds. A single patch increment may not cover all recorded advisories. Do not blindly apply npm's major-version suggestions. Evidence: the original app and MCP npm audit inventories; rerun npm audit for current versions.

## Reliability and usability

### R1 - Medium: Undo can finish without reversing the action

**Code:** `lib/assistant/execute.ts:2208-2279`, especially `:2256`, and inverse operations around `:2312`.

Undo changes status to `undone` before performing the inverse. If the inverse fails, the action remains undone and another attempt is refused. Several inverses ignore returned database errors: a note deletion can fail while Undo returns success and the note remains. Both were reproduced. The database lifecycle trigger does not provide a transition back for the failed inverse.

**Fix:** introduce a recoverable claimed/undoing state, check every persistence result, and mark undone only after confirmed success. Make inverses idempotent. Expose partial failure/retry and distinguish irreversible provider operations from reversible local changes.

### R2 - Medium: writes can succeed without durable history or final state

**Code:** `lib/assistant/execute.ts:587-610,2005`; audit helper at `:134`.

A note can be saved while its action-history insert fails; the caller receives success without an operation ID or undo entry. A provider send can succeed while the final `executed` update fails; the call reports success and leaves an `approved` action carrying an execution claim. Many audit inserts ignore returned errors. All three paths are relevant to recovery; the first two were failure-injection tested.

**Fix:** transact local mutation/history where possible. For provider effects, use durable intent, result identifiers, idempotency and reconciliation. Return an explicit uncertain outcome where necessary; never blindly retry sending after a persistence failure.

### U1 - Medium: shared drawers fail keyboard interaction

**Code:** `components/ui.tsx:307`.

Opening New task leaves focus on the background `+ Task` button. There is no dialog role/modal/title association; Escape does not close it; Shift+Tab from Close escapes into the background. Chromium interaction confirmed all of these. Axe found no violations inside the drawer, showing why automated checks alone are insufficient.

Use an accessible dialog primitive with initial focus, containment, Escape, inert background and focus restoration. Handle dismissal of modified forms explicitly. Verify keyboard and screen-reader behavior in signed-in workflows after fixing the shared component.

### U2 - Medium: component semantics and contrast need correction

At 320 and 390 pixels, axe found three calendar lists with direct button children instead of list items, location text at approximately **3.85-3.95:1** contrast, and a month-pack horizontal scroll region that is not keyboard focusable. An “own cost” badge was approximately **4.27:1**, including desktop. These normal-size text elements require 4.5:1 contrast under WCAG AA.

**Code:** `components/calendar/calendar-view.tsx:473,515`; `components/trips/month-pack.tsx:200`; `components/trips/trip-detail.tsx:354`.

Wrap list entries in `li`, improve muted foreground/background combinations, and label/make scroll regions keyboard reachable. Fixture-level main/region/heading-order warnings were excluded because the preview combines otherwise separate screens. This is not a whole-app accessibility compliance assessment.

### U3 - Medium: failed scans cannot immediately retry

**Code:** `lib/cron/guard.ts:33`; `app/api/cron/scan/route.ts:33-39`.

A recent started row blocks a scan for ten minutes. The query includes started/success rows but excludes failure rows, so a known failure cannot release the guard immediately. The fresh behavioral test fails at `scripts/b24.test.ts:217` on the expected successful retry after a model 401. The failure at `:240` is a source-shape assertion expecting the previous success-only query, not a separate product defect.

Track run IDs and terminal states, and claim work atomically. Known failures should release the running guard while genuinely active runs remain protected. Update the structural assertion to match the intended policy while retaining the behavioral test.

### U4 - Low: login recovery and documentation mislead

The callback sends `error=invalid_link`, but login does not explain expired/used links. Generic database/service errors map to “This email is not allowed,” and the error paragraph lacks live announcement semantics. Earlier browser evidence and current source support these findings. Explain invalid links, distinguish service outages from access denial, and offer clear resend/retry actions.

MCP README counts and claims about attachments/queued rejection lag the registry. Generate docs from the manifest and disclosure rules. Explain the difference between app proposals, provider reply drafts, approval, execution and undo using the same terms throughout the UI and MCP.

## Working controls and corrections to the previous review

- Compiled MCP initialization, tool discovery and adapter round-trips passed with an actual SDK client.
- Mail sends queue before provider calls. New events explicitly carrying attendees require confirmation. No MCP approval tool is exposed.
- SQL checks rejected an unapproved signup email, cross-owner task reads/inserts, service-role edits of owner instructions/invoiced billing, service-role transcript reads, and authenticated execution of the token-retrieval function. All 24 public tables have RLS enabled; anonymous queries returned no accessible rows in the seeded fixture.
- Direct SQL service-role deletion of a protected task is possible, but the actual `delete_task` performer explicitly refuses pending instructions and invoiced tasks. **This is not reported as an MCP authorization bypass.** Some protections intentionally reside in application code.
- The house-rules read checks that disclosure auditing succeeded before returning persona content. Preserve that fail-closed behavior while fixing consent.
- The first approval click changes the button to “Tap again: this sends the email” and offers Cancel. Testing stopped before the second click. The task drawer's labels/spacing were readable on mobile, and none of the three tested widths had page-wide horizontal overflow.
- **Correction:** the earlier nullable-schema finding is withdrawn as an active defect. Traversal of all 67 current tool schemas found no array-valued `type`. The earlier synthetic union probe establishes only a future converter limitation, not a current registry bug. Schema parity tests remain useful.

## MCP feature roadmap

Search, attachments, trip tools, work-hour tracking, undo, queued rejection and several paginated lists already exist. Prioritize reliable contracts and permissions over duplicate tools.

| Priority | Addition | Concrete behavior and acceptance target |
|---|---|---|
| P0 | Per-connection capabilities | Read-only connections; permitted mailboxes/work streams; separate mail-body, attachment, persona, finance and write permissions. Enforce every call and display identical permissions on consent/settings. |
| P0 | Structured results and operation IDs | Return operation ID, affected IDs, state, undo availability, retryability and typed errors through MCP structured content/output schemas. Both transports currently reduce writes to prose; the compiled smoke test confirmed loss of `action_id`. |
| P0 | Idempotency and version checks | Retrying a key returns the same operation, not another task/proposal. Stale edits produce explicit conflicts. Scope keys to client and payload and retain them across timeouts. |
| P1 | Background scan jobs | Start/status/cancel/results with progress. The stdio client times out after 60 seconds while scan routes permit 300. Cancellation must distinguish stopping future work from undoing completed effects. |
| P1 | Preview/diff and bounded bulk work | Show changed fields, affected records, recipients/guests and irreversibility; commit a versioned preview. External effects retain owner approval in the app. Partial results are explicit. |
| P1 | Connection activity and emergency revoke | Attribute calls to connections and disclosure classes; show last use/failures and revoke reliably. Add per-client request/result budgets without logging tokens or private message bodies. |
| P1 | Health and recovery | Account reauthorization needs, sync freshness, scan status, stuck actions and reconciliation state, with safe error codes and owner recovery links. |
| P2 | Resources and reusable prompts | Task/project/trip resources; daily planning, trip readiness and unbilled-work prompts. Include source, freshness and untrusted-content markers; apply tool-equivalent access checks. |
| P2 | Consistent pagination/results budgets | Keep existing pagination, but standardize limits, continuation metadata, ordering and truncation indicators. Add cursor/snapshot behavior where edits make offset paging unreliable. |
| P2 | Generated contracts/conformance checks | Generate docs/consent from registry metadata; compare schemas/results across transports. Test initialization, notification handling, malformed requests and negotiated protocol behavior using SDK clients. |

## Implementation order and release validation

1. Close mail/calendar approval gaps; correct consent; make token rotation and Disconnect transactional and failure-aware.
2. Repair private-cache logout, undo lifecycle and durable action history. Upgrade dependencies with a consistent lockfile and successful production build.
3. Fix drawers, calendar semantics/contrast, scan retries and login recovery.
4. Add scoped connections, operation results and idempotency; then background jobs and previews.

Before release, use a separate development Supabase instance with real Auth/Vault and run the existing integration RLS suite. Exercise OTP/passkeys, signed-in navigation, approved Google/Microsoft sends and guest-event lifecycles using disposable test accounts, concurrent token/disconnect behavior, private offline logout across tabs, and uncertain-provider-outcome recovery. These remain outstanding and cannot be inferred from fixture/mocked passes.

## Historical evidence

The original review used external local harnesses and logs. They are not required to run the application. This file preserves the findings at the reviewed commit, before fixes. See ../../CLAUDE.md and ../CLAUDE_HANDOFF_2026-10-15.md for implementation status, committed regression tests, migration order and remaining validation.
