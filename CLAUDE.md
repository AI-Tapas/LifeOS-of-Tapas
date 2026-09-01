# Life OS

Single-user PWA: executive assistant and work-life second brain for a
practising CA in Ahmedabad, India. Sole user: tapas.tnr@gmail.com.

## Stack

- Next.js (App Router, TypeScript, Tailwind CSS). Next 16, so builds use
  Turbopack; the service worker is hand-written in public/sw.js instead of a
  webpack-based PWA plugin.
- Supabase: Postgres, Auth, Edge Functions, Vault. Local dev via Supabase CLI
  (requires Docker Desktop).
- Deploy: Vercel (frontend) + Supabase cloud (backend).

## Environment note (Cowork sandbox mount)

This repo lives on a local disk, NOT in OneDrive. If a session sees file
truncation, stale reads, or leftover `.git/index.lock` or `.git/HEAD.lock`, that
is the Cowork sandbox mount's shared-filesystem behaviour, not OneDrive. Clear
the stale lock and retry; do not attribute it to OneDrive or re-diagnose.

## Firm constraints (apply to every milestone)

1. Confidential boundary: the app stores task metadata, due dates, and
   reference links only. No document contents, no file uploads of client
   documents, ever. Do not add schema, storage buckets, or UI that invites
   them. Columns like receipt_ref and pdf_ref are reference strings, not
   files.
2. Confirmation: no irreversible or in-the-user's-name action (send mail,
   invite people, send bills) may execute without explicit user confirmation,
   enforced in code. assistant_actions.status must pass through 'approved'
   before 'executed'.
3. Secrets: LLM and OAuth secrets are server-side only. Never ship them to
   the client, never prefix them NEXT_PUBLIC_.

## Conventions

- snake_case for all database identifiers and API fields.
- Timestamps stored UTC (timestamptz), displayed in IST.
- Dates displayed as "17 May 2026"; Indian digit grouping (1,20,00,000) for
  money.
- No emojis and no em-dashes anywhere: UI copy, comments, docs.

## Database workflow

- All schema changes are versioned migrations in supabase/migrations, applied
  with supabase db reset (local) or supabase db push (cloud). Never edit the
  schema from the dashboard.
- Every table has id uuid pk, user_id uuid default auth.uid(), and RLS
  restricting all operations to user_id = auth.uid(). Keep this for any new
  table.
- FK on delete policy: cascade for containment (account to calendars to
  events, trip to expenses, reminder parents), set null for loose links
  (tasks.project_id, bills.trip_id, notes refs), restrict for work_stream
  references.
- After schema changes regenerate types: npm run db:types (stack must be
  running). lib/database.types.ts was hand-authored to match the migrations
  because this machine lacked Docker; regeneration replaces it.

## Auth

- Supabase email OTP (magic link plus 6 digit code; custom template in
  supabase/templates/magic_link.html carries both).
- Sign-ups blocked server-side: a before-insert trigger on auth.users rejects
  any email except the allow-listed one (migration
  20260706000200_auth_allowlist_and_seed.sql). The allow-listed address is
  hardcoded in that migration.
- First user creation also seeds work_streams via an after-insert trigger.
- Passkeys: Supabase Auth now supports passkeys natively but flags them
  experimental (config [auth.passkey], supabase-js auth.experimental.passkey).
  Wired as an alternative sign-in (login page) with registration under
  Settings. If the experimental API breaks on upgrade, OTP remains the
  primary method. Cloud requires enabling passkeys and setting the WebAuthn
  rp_id to the production domain in the dashboard.

## OAuth refresh tokens

accounts.refresh_token_enc holds a Supabase Vault secret id (uuid), not the
token. Store tokens with vault.create_secret() server-side (Edge Function or
service role), read them via vault.decrypted_secrets server-side only. No
client path may ever select the decrypted value. assistant_persona is equally
sensitive: owner-session access only.

## OAuth account connections (Milestone 2)

App-level OAuth to external accounts, separate from Supabase sign-in. Four
slots, keyed by accounts.slot: taxstrategia (google_internal), ca_tapasnr
(google_external), altechon (microsoft), icai (google_external). Slot config
and email-verification rules live in lib/accounts.ts.

- Two Google clients are mandatory: an Internal-audience client cannot serve
  accounts outside its org. Internal serves taxstrategia; External serves
  ca_tapasnr and icai.
- Flow: /api/oauth/[provider]/start and /callback (route handlers), not
  Supabase Auth. PKCE S256 + state on every flow; Google adds
  access_type=offline and prompt=consent to guarantee a refresh token. State
  and verifier ride a short-lived httpOnly oauth_flow cookie. One redirect URI
  per provider; both Google clients register the same string, and the slot in
  the cookie picks the client.
- Callback verifies the returned email against the slot and always rejects
  tapas.tnr@gmail.com. Internal-google and single-tenant-MS are org-bound by
  the client, so only ca_tapasnr (exact email) and icai (domain) need an
  explicit check.
- Tokens: refresh and access tokens both live in Vault. accounts columns
  refresh_token_enc and access_token_enc are secret ids; token_expires_at and
  last_token_use cache expiry. The only decryption path is three security
  definer functions granted to service_role only (set_account_tokens,
  get_account_tokens, clear_account_tokens); no browser role can execute them.
  lib/supabase/service.ts is the server-only service-role client.
- lib/oauth/tokens.ts get_valid_access_token(account_id) returns the cached
  access token or refreshes it, persists Microsoft's rolled refresh token, and
  on invalid_grant throws TokenRevokedError, sets status=needs_reauth, and
  writes an audit_log row.
- A provider-side revocation kills the access token before its expiry clock, so
  a cached token can still 401 at the resource API. Every resource call (M3
  calendar/mail included) must go through lib/oauth/tokens.ts withResourceAuth:
  on a 401 it forces one refresh and retries once, and on a revoked grant or a
  persistent 401 it flips status=needs_reauth (never a raw 500). The pure
  orchestration is providers.ts resourceWithReauth (unit-tested offline).
- Re-auth design: needs_reauth surfaces as an amber banner in the (app) shell
  and Settings with one-tap Reconnect (reruns /start). This is the expected
  path when the ca_tapasnr password changes. connect, disconnect,
  refresh-failure and reconnect are all audit-logged.
- icai fallback: if the org blocks the unverified app, the row is saved with
  connect_mode=forwarded, status=forwarded, no tokens (Settings toggle). Mail
  then arrives via a Gmail forwarding filter into ca_tapasnr.
- Calendars: metadata only (event sync is M3). calendars.is_primary_write is
  one-per-account and is_reminder_home one-per-user (partial unique indexes);
  a trigger forces the reminder-home onto the ca_tapasnr account.
- accounts.status enum: connected, needs_reauth, forwarded, disconnected.
  accounts.oauth_client enum: google_internal, google_external, microsoft.

## Testing

- npm run test:rls proves anon cannot read or write any table, non
  allow-listed users cannot be created, and the owner sees the seeded data.
  Requires supabase start. npm run test:rls:cloud runs the same proof against
  the cloud project via the SUPABASE_URL / SUPABASE_ANON_KEY aliases in
  .env.local.
- npm run test:oauth proves the pure OAuth token logic (PKCE S256 vector,
  token-response parse, Google/Microsoft refresh, invalid_grant to revoked)
  with mocked providers. No stack; needs Node 22.18+ for .ts type stripping.

## Assistant layer (Milestone 4)

- LLM: open provider config in lib/assistant/config.ts. Named presets
  (anthropic, nvidia, deepseek) carry a wire format, base URL, default model and
  their own key var, so several providers' keys coexist and LLM_PROVIDER
  alone switches the live one. Generic LLM_API_FORMAT / LLM_BASE_URL /
  LLM_API_KEY / LLM_MODEL override a preset and cover unlisted hosts.
  Two wire formats sit behind one runner (runLlmTurn in
  lib/assistant/llm.ts): 'anthropic' (official SDK, adaptive thinking,
  cache_control on the hard-rules block) and 'openai' (Chat Completions
  SSE). LLM_THINKING=off and LLM_STRICT=off are the degrade switches.
  Dialect mapping is pure in lib/assistant/wire.ts (offline-tested);
  buckets and gates are format-independent.
- Tool registry: lib/assistant/tools.ts is the fixed tool list and the
  security boundary. Buckets enforced in lib/assistant/execute.ts:
  autonomous (tasks, reminders, notes, people, obligations, solo events,
  app-DB email drafts) execute immediately and are undoable; confirm
  (send_email, propose_event_with_invites) only ever insert a proposed
  assistant_actions row. Stubs: gst wiki, trips, bills. There is no tool
  that mutates assistant_actions.status, fetches URLs, or reads documents.
- Approval gate: approve happens only in the owner-session server action
  (app/(app)/assistant/actions.ts -> approveAndExecute). Approval records a
  sha256 payload hash; the executor (runApprovedExecution in
  lib/assistant/core.ts, pure and offline-tested) requires status=approved,
  a hash match, and a compare-and-swap claim on executed_at. The DB trigger
  guard_assistant_action_update freezes payloads once status leaves
  proposed and whitelists status transitions for every role.
- add_event_solo has no attendees field in its schema, the executor refuses
  smuggled attendee keys, and it calls createEvent with confirmed=false so
  the M3 attendee gate is a third belt. Invite events execute only through
  the approved queue with confirmed=true.
- Mail-to-task (on demand, Assistant tab button): per-account isolated model
  context whose only tool is propose_task. Gmail metadata format + snippet,
  Graph bodyPreview; bodies and attachments never fetched or stored. Mail
  text enters context inside fenceUntrusted (fixed data-not-instructions
  preamble + provenance). Output schema-constrained; external_ref must match
  a scanned message id; capped 20 proposals/account/day; deduped on
  external_ref. Tasks land source=email, and context rendering wraps
  source=email rows in the same untrusted framing.
- Scan feedback loop (found live 31 Aug 2026, fixed; do not regress): the
  7 AM brief is sent from ca_tapasnr to itself, so it lands in the inbox the
  3 AM scan reads. The scanner re-filed the tasks the brief was reporting,
  one fresh copy per day, because each morning is a new message id and the
  external_ref dedup only catches the same message twice. lib/assistant/
  scan-filters.ts holds both belts, pure and tested in scripts/m5.test.ts:
  isAppGeneratedMail drops anything carrying the X-Life-OS header the brief
  now sets, or a self-addressed message whose subject starts with the brief
  prefix (for briefs predating the header); isAlreadyOpen refuses a proposal
  whose normalised title already matches an open task. Never widen the first
  to "ignore all mail from myself": mailing yourself a reminder must still
  become a task, and a test pins that.
- Persona: assistant_persona versions, seeded v1 by migration. System prompt
  order is fixed: hard rules (with the precedence line), app context, then
  the persona inside a labelled tone-only block. Persona writes happen only
  through Settings server actions; the model has no persona tool. A hostile
  persona provably cannot change gate behaviour (scripts/m4.test.ts).
- audit_log is append-only for authenticated (UPDATE/DELETE revoked);
  propose/approve/reject/execute/undo and mail scans are all logged.
- people.unverified flags assistant-created people; the queue UI shows raw
  recipient addresses, the sending account, the full body, and highlights
  unverified and first-time recipients. Approval is a two-tap button; there
  is no approve-all.
- Tool schema convention (do not regress): every parameter carries ONE
  concrete type and optional parameters are simply left out of `required`.
  No nullable type arrays, no anyOf. Anthropic rejects a tool set with more
  than 16 union-typed parameters, and rejects an enum beside a nullable
  type; the OpenAI strict idiom (all-required plus nullable) is therefore
  off by default and opt-in via LLM_STRICT=on. Strict mode itself is off on
  BOTH dialects: Anthropic strict compiles a grammar capped at 16 union-typed
  and 24 optional parameters, and this tool set has 31 optional ones. Nothing
  in the security model depends on strict; lib/assistant/execute.ts validates
  every argument server-side and the approval gate is independent of it.
  scripts/m4.test.ts walks every schema, fails on any union, and records the
  parameter census. GET /api/assistant/health reports the live commit and
  that census.
- Per-activity model choice: Settings > Assistant models writes provider
  and model names into assistant_settings (chat_* and scan_* columns);
  loadLlmOverride feeds them to runLlmTurn, so the chat and the mail scan
  can run on different providers. Only names are stored: keys stay in the
  server environment. When Settings picks a provider other than
  LLM_PROVIDER, the generic LLM_BASE_URL / LLM_API_FORMAT overrides are
  ignored for that call, since they describe the env provider.
- GET /api/assistant/health (owner session) pings the configured provider;
  ?role=scan tests the scan model instead of the chat one. Settings has a
  Test button per activity.
- The chat transcript is kept in localStorage on the device (key
  life_os_assistant_chat_v1, last 40 turns), cleared by the New chat
  button. Deliberately not a table: no cross-device sync in M4.
- MCP connector: POST /api/mcp (bearer LIFEOS_MCP_TOKEN, timing-safe compare,
  exempted from the cookie gate in proxy.ts because it authenticates itself)
  serves a manifest plus read and write ops. Write ops route through the same
  executeToolCall, so buckets, hashes and the queue behave identically for an
  outside model. Approve, reject, execute and undo are deliberately NOT on
  that surface. lib/assistant/actor.ts supplies the identity: cookieActor for
  the browser, serviceActor for token-authenticated callers. Task writes moved
  to lib/tasks/write.ts so all three callers share one implementation. The
  server itself lives in mcp-server/ (its own package, excluded from the Next
  tsconfig and eslint; stdio transport, and it fetches its tool list from the
  app so it cannot drift).
- Tool surface (31 registry tools, shared by the in-app assistant and both
  connectors): create/update/delete for tasks, notes, people, obligations,
  finance items and projects; solo calendar events including edit and delete
  (delete_event refuses anything with source other than 'app', so a synced
  event is never removed); draft_email; scan_mail; undo_action;
  reject_queued_action. Ten read tools mirror them, so nothing writable is
  invisible. send_email and propose_event_with_invites stay confirm-bucket,
  and NO tool approves: approval is owner-session only, in the app.
- Remote MCP connector (ChatGPT, Claude web and mobile): POST /api/mcp/http
  speaks Streamable HTTP with stateless JSON replies, handling initialize,
  tools/list, tools/call and ping directly rather than pulling the MCP SDK
  into the Next runtime. Guarded by an OAuth 2.1 bearer token.
- The app is its own authorization server: dynamic client registration
  (/api/mcp/oauth/register), authorize, token and revoke under
  /api/mcp/oauth/*, with discovery rewritten from /.well-known/* in
  next.config.ts because Next ignores dot-prefixed folders. Public clients
  with PKCE S256 only, no client secrets. Codes are single use, five minutes,
  bound to client and redirect URI; refresh tokens rotate on use; every
  secret is stored as a sha256 hash in mcp_grants. The authorize step demands
  a live owner session and a two-tap consent screen at /connect, so a token
  exists only because Tapas approved it. Settings lists connections and can
  revoke them. Rules are pure in lib/mcp/oauth-core.ts and tested offline.
- Tests: npm run test:m4 (offline, the R6 red-team controls). rls.test.mjs
  adds audit_log append-only and payload-immutability trigger proofs.

## Travel Desk (Milestone 6)

- Schema: trips, trip_expenses and bills shipped in M1 with the right shapes.
  Migration 20260828000100_m6_travel_desk.sql adds only what was missing:
  trip_status gains 'underway' and 'billed' (the trail is planned, underway,
  done, billed; 'booked' and 'cancelled' stay valid), bills gains
  bill_to_address (the enum says which kind of payer, the bill still has to
  print a name and address), and billing_profile holds the letterhead. The
  seed_new_user trigger now seeds a billing_profile row too.
- receipt_ref and pdf_ref stay reference strings. There is no upload path, no
  storage bucket and no attachment UI anywhere in this module, and
  scripts/m6.test.ts fails if any tool grows a file-shaped parameter.
- lib/trips/bill.ts is pure: leg and line-item parsing, line items derived
  from billable expenses, the billable rollup, Indian amount-in-words, and
  financial-year bill numbering (AICA/2026-27/001, restarting each April).
  Relative .ts imports so node --test can run it.
- lib/trips/write.ts is the one write path, same pattern as lib/tasks/write.ts:
  browser server actions, the in-app assistant and the MCP connectors all go
  through it. createBillDraft can only ever write status 'draft'.
  setBillStatus (sent, paid) exists only for the Trips screen: no assistant or
  connector tool can reach it, because the app never sends a bill.
- Screens: /trips groups the month ahead and lists past trips below;
  /trips/[id] carries legs, expenses by category and the bills; /trips/bill/[id]
  is the print view. The PDF is the browser's own Save as PDF driven by the
  @media print block in globals.css (everything hidden except .print-sheet),
  so no PDF library is installed.
- His working rules live where each fits: the transport preference order and
  the AICA "arrive the night before, the branch books the hotel" note sit in
  the leg and trip forms; the more-than-a-day gap between trips shows as an
  observation with no merge button (chaining is a question, never automatic);
  and the same three rules are in HARD_RULES so the assistant says the same
  thing in chat.
- Assistant tools: the three trip stubs became real autonomous, undoable tools
  (create_trip, update_trip, log_trip_leg, add_trip_expense,
  create_bill_draft), mirrored by the read tools lifeos_list_trips and
  lifeos_list_bills.
- Tests: npm run test:m6 (offline). app/dev-preview renders the three trips
  screens with mock data for visual checks without a database.

## Theme (Settings > Appearance)

- Three-way choice: System, Light, Dark. Stored in localStorage on the device
  (`life_os_theme`), NOT in the database: it describes the screen in front of
  you, so phone and laptop may reasonably differ.
- The dark palette is keyed on `:root[data-theme="dark"]`, never on the media
  query. `THEME_BOOT_SCRIPT` in lib/theme.ts runs in the document head before
  first paint, resolves System against `prefers-color-scheme`, writes the
  attribute, and keeps listening so a device flip still follows while the app
  is open. No script means light, which is the primary theme by design.
- `@custom-variant dark` in globals.css repoints Tailwind's `dark:` utilities
  at the same attribute. Without it an explicit choice half-applies: the
  tokens flip and the ~37 `dark:` classes do not. Do not remove it.
- The Settings control reads the value through `useSyncExternalStore`, not an
  effect: localStorage is external state, and reading it in an effect both
  trips react-hooks/set-state-in-effect and paints the wrong option briefly.

## Trip checklists (Milestone 6b)

- tasks.trip_id (migration 20260831000100) makes a task a trip's checklist
  step. on delete set null, the house rule for loose links: deleting a trip
  turns its steps back into ordinary tasks rather than destroying work.
- A step is an ordinary task on purpose. It keeps its due date, priority,
  undo path and Google Calendar reminder; only where it is SHOWN changes.
- lib/tasks/trip-rollup.ts is the one ranking implementation, beside
  triage.ts. Home, the Tasks overview and the morning brief all call
  rollUpTrips, so they cannot drift. A rollup row inherits the priority and
  due date of the trip's most urgent incomplete step, so it lands in exactly
  the band that step would have earned alone; it names that step, counts
  honestly ("2 of 5 done", dropped steps out of the denominator), and a trip
  with no open steps produces no row at all. The rollup id is `trip:<uuid>`,
  never a task id.
- The rollup applies to the ranked surfaces only. The Tasks Board, Inbox and
  Projects tabs still list every step as its own row, so nothing is
  unreachable from the task list itself.
- lib/trips/checklist.ts is the one definition of the five standard steps and
  their dates (onward and return 7 days before the start, hotel 5 days
  before, receipts on the end date, the bill 2 days after). A date that would
  land in the past is clamped to today. No start date means no checklist
  rather than guessed dates. Non-AICA trips lose the branch wording, and the
  reimbursement step only appears when somebody actually pays.
- Seeding runs through lib/trips/write.ts seedTripChecklist, called by
  createTrip when with_checklist is set. The add-trip drawer defaults it on,
  the connector tool defaults it off, and both go through that one function.
- create_task and update_task take an optional trip_id, so the assistant and
  both connectors can attach travel admin to a trip (including the 36 tasks
  already in the live database). lifeos_list_trips returns checklist_done and
  checklist_total. No new tool, no bucket change, no new approval path.
- Tests: npm run test:m6b (26 offline tests: rollup counts and rank
  inheritance, checklist date derivation and the past-date clamp, the brief
  ranking the same rows, and the tool-schema rules).
