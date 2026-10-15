# OAuth security implementation handoff

Date: 15 October 2026. Implements review findings S3, S4 and the OAuth-registration part of S7. These changes are local implementation work; no production database migration or deployment was performed.

## Findings and changes

- **S3, concurrent exchange and ineffective disconnect.** Earlier routes separately checked, consumed and issued credentials. Concurrent requests could both issue credentials, and refresh could issue after a connection was deleted. Returned database errors were ignored. The migration adds service-only RPC transactions for registration, approval, code exchange, refresh rotation, token revocation and owner disconnect. Lifecycle operations lock the client before its grant. Disconnect retains a durable `revoked_at` tombstone and revokes all grants in that same transaction. The MCP transport also checks the active approved client, implemented alongside capability enforcement.
- **Replay detection.** New grants carry a `family_id`. Code/refresh consumption sets `used_at`; reuse revokes the whole family, including issued descendants. Revocation is returned as an ordinary invalid-grant result so the transaction commits it. Incorrect PKCE or a different client cannot burn a valid code. Failed grant insertion rolls back consumption. A simultaneous duplicate exchange produces one successful response, then the replay invalidates that response's family. A client must reconnect after replay; it must not repeatedly retry a consumed credential.
- **Disconnect failures.** The server action returns failure unless the revocation transaction confirms success. Errors no longer remove a visible registration while leaving tokens valid. The token-revocation endpoint still hides unknown credentials with HTTP 200, but returns 503 for storage failure so the caller can retry. Repeated owner disconnect is safe.
- **S4, inaccurate consent.** The consent form uses `CAPABILITY_DESCRIPTIONS` from `lib/mcp/permissions.ts`, the shared capability contract. It defaults to read-only app records. Mail content, attachments, persona, finance and writes require explicit selection. Account/work-stream selections are validated against owner records; the server creates credentials, saves permissions and records the consent audit in one transaction. Missing Origin, another origin, missing owner session or an invalid security challenge is rejected. Plain HTML form approval remains usable without JavaScript.
- **S7, malformed/abusive registration.** JSON shapes, names, URI lengths/counts and OAuth types are validated before database access. Bodies are limited to 16 KiB by bytes actually read, including streamed requests. Redirects cannot contain credentials, fragments, backslashes or control characters. Registration has a shared database quota of 30 per owner per hour and at most 100 outstanding unapproved registrations. This intentionally does not trust caller-controlled IP headers. Unapproved registrations expire after 24 hours and are deleted during a later registration transaction. This bounds growth; it does not promise continuous scheduled cleanup or protection from an attacker temporarily consuming the registration budget.

## Deployment and reconnection

Apply `supabase/migrations/20261015000200_oauth_security.sql` before routing traffic to the new OAuth handlers. It adds client approval/revocation/capability fields, refresh-family IDs and a composite owner/client foreign key. It removes orphan grants left by older registration deletion.

**Existing grants are revoked deliberately.** Existing clients have no approved capability selection and must reconnect to review permissions. There is no automatic migration from broad legacy access to invented consent. Re-consenting a registered client revokes its earlier grants before issuing a new code. A disconnected client is a tombstone and must register again.

The scope string remains `lifeos` for connector compatibility. Actual permissions are the server-enforced capability record, not that scope label. A narrowed mailbox/work-stream selection disables tools whose handlers cannot safely isolate those records; the consent screen says so. These controls do not yet imply fully functional joined-record filtering. Shared-secret stdio/legacy HTTP access is configured separately by the owner and does not inherit an OAuth client's selection.

The new database functions are executable only by `service_role`, with a fixed search path. They are not exposed to anonymous or owner-session RPC callers. Generated/hand-maintained database types must include these functions and new columns; the parent orchestrator owns that update.

## Verification

Commands:

```sh
node --test scripts/oauth-security.test.ts
node --test scripts/oauth-sql.test.ts
```

- Route/core suite: 8 tests passed. Checks malformed registration, streamed-size bounds, quota responses, issuance failure without credential disclosure, failure-aware disconnect/revoke, registration expiry, same-origin consent and invalid owner mailbox/work-stream selections.
- SQL suite: 10 tests passed, applying all 35 migrations present when first run. Checks legacy fail-closed behavior, re-consent, PKCE/client binding, one winner under queued duplicate exchange, family replay, rollback on failed token insert, rollback on failed disconnect audit, refresh/disconnect sequencing, foreign-key cascade, rate limits/expiry and service-only RPC privileges.
- `scripts/helpers/sql-fixture.ts` is reusable by other regression suites. It runs actual migrations in PGlite, using synthetic Supabase auth claims and Vault stubs. `PGLITE_MODULE_PATH` can point to an existing PGlite installation for an isolated review workspace; a normal checkout uses the declared development dependency.

PGlite here runs PostgreSQL 18.6 and serializes statements. It tests the database implementation and rollback semantics, but does not independently prove concurrent lock scheduling on production PostgreSQL 17. Before release, run two independent PostgreSQL sessions racing exchange/refresh/disconnect, and exercise actual Supabase Auth and external connector authorization. No production credentials or real external delivery were used.
