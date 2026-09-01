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
   them. Columns like receipt_ref are reference strings, not files.
2. Confirmation: no irreversible or in-the-user's-name action (send mail,
   invite people) may execute without explicit user confirmation, enforced in
   code. assistant_actions.status must pass through 'approved'
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
  (tasks.project_id, tasks.trip_id, notes refs), restrict for work_stream
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
  assistant_actions row. Stub: gst wiki. There is no tool that mutates
  assistant_actions.status, fetches URLs, or reads documents, and since M6d
  no tool bills or invoices anything.
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

## Travel Desk (Milestones 6 and 6d)

- Schema: trips and trip_expenses shipped in M1. Migration
  20260828000100_m6_travel_desk.sql added the status trail ('underway',
  'billed'; 'booked' and 'cancelled' stay valid). Migration
  20260901000300_m6d_invoice_feed.sql replaced trips.billable_to (free text)
  with trips.bills_to, enum trip_bills_to: icai_monthly (the default),
  chapter_aed, none.
- The bills and billing_profile TABLES are UNUSED. Nothing in the app reads
  or writes them since M6d; they are left in place only because dropping a
  table is irreversible. A later migration can remove them, along with the
  bill_recipient and bill_status enums and the billing_profile insert in
  seed_new_user.
- receipt_ref stays a reference string. There is no upload path, no storage
  bucket and no attachment UI anywhere in this module, and scripts/m6.test.ts
  fails if any tool grows a file-shaped parameter.
- lib/trips/bill.ts is pure trip logic despite its name (M6d emptied it of
  bills): transport modes, leg parsing, the billable rollup, and the date
  labels. Renaming it was left out of M6d to keep that diff small.
- lib/trips/month.ts is the month pack, pure: which month a trip belongs to,
  what the ICAI claim excludes, the receipt gaps, and the plain text the Copy
  button puts on the clipboard.
- lib/trips/write.ts is the one write path, same pattern as lib/tasks/write.ts:
  browser server actions, the in-app assistant and the MCP connectors all go
  through it. Nothing in it writes a bills row.
- Screens: /trips groups the month ahead and lists past trips below;
  /trips/[id] carries legs, checklist and expenses by category; /trips/month
  is the month pack. There is no print view and no @media print block: the
  app produces no document.
- His working rules live where each fits: the transport preference order and
  the AICA "arrive the night before, the branch books the hotel" note sit in
  the leg and trip forms; the more-than-a-day gap between trips shows as an
  observation with no merge button (chaining is a question, never automatic);
  and the same rules are in HARD_RULES so the assistant says the same thing
  in chat.
- Assistant tools: create_trip, update_trip, log_trip_leg, add_trip_expense,
  all autonomous and undoable, mirrored by the read tool lifeos_list_trips
  (which now reports bills_to and receipts_missing).
- Tests: npm run test:m6 (25 offline). app/dev-preview renders the trips
  screens and the month pack with mock data for visual checks without a
  database.

## Billing: what this app does NOT do (Milestone 6d)

M6 built a per-trip reimbursement bill, addressed to "ICAI <city> Branch",
numbered AICA/2026-27/001, printed from the browser. Every specific was
wrong, because the milestone was written without asking how Tapas bills. He
bills MONTHLY, to the ICAI AI committee and never to a branch, as two
invoices (professional fees and a reimbursement claim with a line-item
annexure), numbered from ONE continuous series across all his clients
(TR-2026-00NN) that no AICA-only view could derive. It is produced by a
formula-driven workbook on his own machine, signed with his DSC and mirrored
into Zoho Books.

So Life OS holds the month accurately and hands it over. Do not rebuild any
of the following, in any milestone:

- No bill or invoice row, number, series, total, fee computation or PDF.
- No letterhead, no print stylesheet, no amount-in-words.
- No Zoho call, no workbook write.
- The month pack shows no total he could mistake for a claim.

Two rules that belong to his invoice process and must stay out of this app:
overseas rows are handled by the bills_to exclusion and nothing more, and
industry sessions are relabelled on the invoice itself. Record what a trip
actually is; let the invoice run do the formatting.

What the app does instead:

- bills_to on every trip. chapter_aed (Dubai, Abu Dhabi) is excluded from the
  month pack entirely, says so on the trip, and seeds its own task, "Raise
  the AED invoice to the <city> chapter", due three days after the trip ends,
  attached as a checklist step. That step is seeded whether or not the
  checklist was asked for: the overseas invoice happens once or twice a year
  and forgetting it is the stated risk.
- The city, not the branch, is the strongest element after a trip's own name
  on the trips list, leads the trip detail, and appears in the rollup line
  (lib/tasks/trip-rollup.ts tripCityLabel, which does not repeat a city the
  title already carries).
- Receipt chasing while the month is still open: a billable trip_expense with
  an empty receipt_ref is marked and counted on the trip, raised as a
  standing line on the trips list for the current and previous month, and
  named in the morning brief from the 25th onward only (briefGapLine).
- /trips/month gathers the chosen month (previous month by default):
  sessions, travel legs, expenses by trip with the receipt reference or "no
  receipt on file", the excluded trips with their reason, and the gaps as a
  numbered list. One "Copy for the invoice run" button puts it on the
  clipboard as plain text. That is the entire integration.
- One recurring task, "Raise the AICA invoice for last month", monthly, due
  on the 3rd, seeded into the ICAI stream by migration 20260901000300. It
  replaced the per-trip "Build the reimbursement bill" step.

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
  honestly ("2 of 4 done", dropped steps out of the denominator), and a trip
  with no open steps produces no row at all. The rollup id is `trip:<uuid>`,
  never a task id. Since M6d the label also names the city.
- The rollup applies to the ranked surfaces only. The Tasks Board, Inbox and
  Projects tabs still list every step as its own row, so nothing is
  unreachable from the task list itself.
- lib/trips/checklist.ts is the one definition of the four standard steps and
  their dates (onward and return 7 days before the start, hotel 5 days
  before, receipts on the end date), plus the chapter_aed invoice reminder 3
  days after the end. A date that would land in the past is clamped to today.
  No start date means no checklist rather than guessed dates. Non-AICA trips
  lose the branch wording. M6d removed the per-trip "build the bill" step.
- Seeding runs through lib/trips/write.ts seedTripChecklist, called by
  createTrip when with_checklist is set. The add-trip drawer defaults it on,
  the connector tool defaults it off, and both go through that one function.
  A chapter_aed trip additionally seeds the AED step alone (scope
  'aed_only') even when the checklist was declined.
- create_task and update_task take an optional trip_id, so the assistant and
  both connectors can attach travel admin to a trip (including the 36 tasks
  already in the live database). lifeos_list_trips returns checklist_done and
  checklist_total. No new tool, no bucket change, no new approval path.
- Tests: npm run test:m6b (26 offline tests: rollup counts and rank
  inheritance, checklist date derivation and the past-date clamp, the brief
  ranking the same rows, and the tool-schema rules).

## Hotel arrangement (Milestone 6c)

- trips.hotel_arrangement (migration 20260901000100) is a four-value enum:
  branch (an ICAI branch arranges it), self (he books it, reimbursable),
  relative (staying with family), same_day (back the same day). Nullable,
  with NO database default.
- It is not a label. It decides which checklist step exists, which is the
  whole value of the field:
    branch    "Confirm hotel with the branch", due 5 days before the start
    self      "Book hotel", due 7 days before, alongside the tickets
    relative  no hotel step at all
    same_day  no hotel step, and the onward-ticket note drops the
              "arrive the night before" line
- Default for a NEW trip: branch, whatever the purpose. An ICAI branch
  arranges his hotel on almost every trip; industry batches at company sites
  (Royal Enfield Chennai, L&T Chennai) are the one or two a month where he
  books, and he sets those by hand. Industry batches have NO trip purpose of
  their own, so the default must never be guessed from purpose or title. The
  single exception is dates: start and end on one date defaults to same_day.
  In the add-trip drawer the default follows the dates until he taps the
  control; after that his choice stands even if he edits the dates.
- Reading an existing row: a null column resolves to branch
  (resolveHotelArrangement). Deliberately NOT read from the dates, so a row
  written before this milestone never silently becomes same_day.
- Changing the field NEVER rewrites checklist steps behind him. The trip
  screen compares what the checklist would be against what is there and
  offers one explicit "Update the checklist" action (syncHotelStepAction),
  which touches a step only while it is still at 'todo' with wording the app
  itself wrote (HOTEL_STEP_TITLES). A step he has completed, started, dropped
  or retitled is left alone and the screen says so. A removed step is
  dropped, never deleted.
- The old hard rule "the branch arranges the hotel, so do not offer to book
  or track hotels for AICA trips" was false once this field existed and would
  have made the assistant refuse help on exactly the trips that need it. The
  replacement in HARD_RULES follows the field: confirmation on branch trips,
  real help on self trips, nothing on relative or same_day.
  lifeos_list_trips returns hotel_arrangement so a connected model can obey
  it, and create_trip and update_trip take it as an optional single-typed
  enum.
- Expenses: on relative and same_day the hotel category is ordered last in
  the expense drawer, never removed. Plans change, and a night he did pay for
  must still be recordable.
- Tests: npm run test:m6c (21 offline tests: the four checklists, the
  night-before line, the branch default and the same-dates exception, null
  rows resolving to branch, and the tool-schema rules).
## Priority provenance (B3)

- The problem B3 fixes: Home ranks urgent-and-important first, then
  important, then urgent, and importance is tasks.priority. Tapas had never
  set it, so all fifty live tasks were 'medium' and the "Do first" band
  ranked on the clock alone, which is the method he named as his problem.
  The ranking was sound and its input was empty.
- Migration 20260901000200 adds tasks.priority_source (enum manual |
  assistant, default 'manual', so every pre-existing row counts as his) and
  tasks.priority_reason text.
- THE RULE, and it is not negotiable: his hand always wins, permanently. No
  assistant path may overwrite a priority whose priority_source is 'manual',
  in either direction. Enforced once in lib/tasks/write.ts so the browser,
  the chat, the mail scanner and both MCP connectors all inherit it.
- createTask and updateTask now take a fourth argument, the origin:
  "app" (his own forms, the ONLY origin that writes 'manual'), "assistant"
  (chat, scan, connectors), or "undo" (restoring a pre-write snapshot,
  provenance included, and still refused over a manual priority). The
  decision is pure in lib/tasks/priority.ts; scripts/b3.test.ts also reads
  the call sites and fails if an assistant path ever passes "app".
- An assistant priority with no reason is REFUSED, not silently written. The
  reason is the whole point: it is what lets him disagree. Reasons are
  collapsed to one line and capped at 200 characters (cleanReason) before
  storage, so a reason derived from untrusted mail cannot reshape a row, and
  they render as plain text only, never markup or a link.
- No tool schema declares priority_source, at any spelling, and b3.test.ts
  fails if one ever does. propose_task, create_task and update_task gained
  priority_reason; propose_task also gained priority, validated the same way
  work_stream is (one of the three real values or nothing, and a priority
  without a reason is dropped while the task still lands).
- On his own form, a CHANGED priority becomes his and clears the reason; an
  unchanged one is left alone, so saving a title edit does not silently erase
  a reason he has not read. A recurring task's next occurrence inherits both
  columns.
- "Unrated by anyone" is priority 'medium' with no reason: he moved nothing
  off the default and the assistant has said nothing. The Tasks overview adds
  one line when that is 60% or more of at least five open tasks, linking to
  /assistant?ask=priorities, which types (never sends) "Review my task
  priorities" into the chat box. No batch UI and no scheduled re-prioritising:
  a chat pass is a conversation he can argue with, which is the point.
- Tests: npm run test:b3 (17 offline).
- Tests: npm run test:m6b (31 offline tests: rollup counts and rank
  inheritance, the city in the label, checklist date derivation and the
  past-date clamp, the chapter_aed reminder, the brief ranking the same
  rows, and the tool-schema rules).

## Reminder mode: the calendar is for interrupts (Milestone 7a)

- Every dated task used to write its own Google Calendar event at 09:30 IST
  with four notification overrides. A month of AICA travel is six trips at
  four checklist steps each, so his calendar carried about twenty-four
  stacked entries for routine admin and he stopped reading it.
- tasks.reminder_mode ('calendar' | 'in_app', default 'calendar', migration
  20260901000400) decides whether a task writes that event. 'in_app' writes
  no event; the task still ranks on Home, still appears in the 7 AM brief and
  still counts in its trip rollup. Nothing is hidden.
- The decision is pure: planTaskReminder in lib/reminders/core.ts, called by
  syncTaskReminder. Switching a task in either direction goes through the one
  removeReminder path, so no orphan event is left behind.
- What the generators choose, by the KIND of work, not by who created it:
  trip checklist steps in_app (lib/trips/checklist.ts sets it per step); the
  overseas chapter AED invoice step 'calendar' (once or twice a year, and
  forgetting it is the risk he named); the recurring monthly invoice task
  in_app; his own forms and the mail scan 'calendar', as before. A completed
  recurring occurrence hands its mode to the next one.
- One trip, one calendar entry: a trip with a start date writes ONE all-day
  event spanning its dates on the same reminder-home calendar, with a single
  override the day before (900 minutes back from midnight, which is 9 am the
  previous day). buildTripEvent is pure; syncTripEvent/removeTripEvent in
  lib/reminders/writer.ts use the existing reminder-home resolution and
  withResourceAuth. The id lives in trips.ext_event_id, because a reminders
  row belongs to exactly one of task/finance_item/obligation.
- Controls: a "Remind me on the calendar" toggle on the task form, and one
  control on the trip screen that sets the mode for all of that trip's open
  steps at once. create_task and update_task carry an optional reminder_mode
  enum; the executor validates it with isReminderMode rather than trusting
  the wire.
- One-off maintenance: SQL cannot delete a Google Calendar event, so the
  migration leaves the events the now-in_app tasks already wrote. Settings >
  Calendar reminders has an owner-session button
  (clearInAppCalendarEntriesAction -> sweepInAppReminderEvents) that removes
  them through removeReminder and reports the count. Safe to run twice, on no
  tool surface, and never run automatically on deploy.
- Tests: npm run test:m7a (27 offline).

## Governance hardening (G1: B8, B10, B11, B12)

Four controls borrowed from the R7 research verdict. All four are in
lib/assistant/, all four are proven offline by npm run test:m4, and there is
no migration: B12 reuses the meta jsonb audit_log has always had.

- B8, disclosure class. A bucket says what a tool may CHANGE. Firm constraint
  1 is a disclosure rule, and no permission setting can enforce a disclosure
  rule: only the absence of the capability can. Every ToolDef therefore also
  carries a ToolDisclosure: none, app_data, mail_metadata or mail_body. There
  is deliberately NO member for document content, so a tool reading a Drive
  file or an O365 attachment could not be given a valid class. The type is
  DERIVED from TOOL_DISCLOSURES, so widening the union means editing that
  list, and the test that reads the list fails when a fifth member appears.
  Do not add one without asking Tapas. A boot-time check in tools.ts throws
  on a registry that drifted past the compiler.
  Enforcement: scan_mail is the only mail_body tool (Gmail snippets and Graph
  bodyPreview are body text, whatever the tool description says), and
  checkDisclosure refuses it when it is reached inside another tool's
  execution. Nesting is tracked with AsyncLocalStorage in execute.ts, not a
  counter: the 3 AM scan and a chat turn can be in flight together.
- B10, fail closed on an unresolved target. The autonomous grant belongs to
  the pair, the verb AND the object, not the verb alone. TOOL_TARGETS in
  tools.ts declares, for every autonomous tool acting on something that
  already exists, which argument names its target and which table it must be
  found in (add_event_solo is the exception: its target is an account slot
  that must be connected). runAutonomousAction in core.ts checks it before
  the performer runs. A lookup that comes back empty is neither swallowed nor
  a reason to proceed: the action drops out of the autonomous bucket and
  lands as a proposed assistant_actions row carrying the reason as its title.
  There is nothing there to approve, so the queue renders it as an attention
  card with a Dismiss control only, and approveAndExecute refuses any kind
  outside SEND_CLASS rather than stranding the row in 'approved'. A MISSING
  argument is not a downgrade: that is a malformed call, and the performer
  refuses it with a message the model can act on.
- B11, unattended execution never raises autonomy. Actor carries origin
  (owner_session | service) and job (cron_scan | cron_brief | null), for the
  audit trail and routing ONLY. routeTool(name) in tools.ts resolves the
  bucket from the tool name and nothing else, and dispatchToolCall settles
  the route before it loads the actor; a test asserts that order and that the
  route is assigned once. draft_email is confirm-bucket now, not autonomous:
  the executor always turned it into a proposed send_email, and the declared
  bucket has to agree with what happens.
- B12, approval provenance. Every assistant audit row carries meta.provenance
  = { basis, tool, disclosure, actor_origin, action_id, payload_hash,
  originating_job }, built by provenance() in core.ts. basis is
  autonomous_bucket, confirm_bucket, owner_approval or downgraded_to_queue.
  execute.ts audit() takes it as a REQUIRED argument, so the compiler, not a
  convention, keeps the rows complete; the Assistant audit tab renders the
  basis in plain words. The cron wrapper rows (cron_scan, cron_brief) are job
  bookkeeping rather than actions and deliberately carry none.


## Which session a trip is for (M7d)

- trips.session_label and trips.session_date (migration 20260901000500).
  The problem: a trip card led with "3 to 5 September 2026", which is the
  TRAVEL span including the night-before arrival, and Tapas had to stop and
  work out which day he was actually teaching.
- session_label is free text, not an enum: "L1D2" is AICA Level 1, Day 2 of
  that batch's course. His schedule carries Level 1, Level 2, Industry and
  Foreign programmes and days D1 to D5, and a new programme must not need a
  migration. Industry rows still take the level they belong to; the word
  Industry never appears (it is faculty reference only, and his invoice
  prints them as the level).
- session_date is the teaching day. It is NOT start_date, and often not
  end_date either.
- sessionLine() and travelDiffersFromSession() in lib/trips/bill.ts are pure
  and drive the card: "L1D2 - 4 Sept - Bangalore" leads, the descriptive
  title sits under it, and the travel span is labelled "Travel ..." and only
  shown when it says something the session date does not (a day return
  would just repeat itself). A trip with neither field reads exactly as it
  did before.
- Both fields are on create_trip and update_trip, so a schedule import fills
  them. prompts/RECIPE-aica-schedule-intake.md carries the mapping.

## Money completed (M7b: investments, B2, B4)

Migration `20260901000600_m7b_money.sql`. Additive, nothing dropped.

- `finance_items` shipped in M1 and gets NO new column here. Which reminder a
  holding writes is DERIVED from `key_date_type`, not stored a second time:
  `financeReminderMode` in lib/reminders/core.ts. A maturity is 'calendar'
  because money is genuinely at stake on the day (an FD that matures
  unnoticed rolls over at a worse rate, which is exactly what M7a reserved
  the calendar for). A review date is 'in_app'.
- `lib/reminders/writer.ts` gained `syncFinanceReminder` and
  `removeFinanceReminder`, on the same `writeReminder` path as tasks and
  obligations, through the `finance_item_id` column M3 carried unused "so M7
  reuses this exact path". There is no second reminder mechanism, and the
  retry sweep picks up finance rows too.
- A review date writes no calendar event, so it needs somewhere to land or it
  quietly passes. Two surfaces carry it, both from `reviewsDue` /
  `reviewLine` in lib/money/investments.ts: one line on Home linking to
  /money, and one block in the 7 am brief. Fourteen-day window, overdue
  reviews included and leading. Do not remove either without replacing the
  reach.
- The Money screen leads with Investments (next maturing, next due for
  review, totals by kind, then the holdings) and Obligations below.
- CONFIDENTIAL BOUNDARY, and money invites the breach hardest: `institution`
  is a short human label ("HDFC, Navrangpura"). No account number, no folio
  number, no customer id, no login, no statement, no upload, and no column or
  tool parameter that could hold one. The rule is in the migration's column
  comments, in the `add_finance_item` / `update_finance_item` schemas the
  model reads, and under the form field. `scripts/m7b.test.ts` fails on any
  parameter or finance_items column matching the account/folio/file patterns.
- B2, sub-monthly obligations: `recurring_obligations.interval_rule` and
  `anchor_date`, plus the enum value 'custom'. interval_rule is the SAME
  "<freq>:<interval>" rule tasks have used since M1: the port is an import of
  `parseRecurringRule`, not a copy, which is why lib/tasks/recurring.ts moved
  to a relative .ts import. There is deliberately no DB check constraint
  tying the pair together, because a constraint mentioning 'custom' would use
  an enum value added in the same transaction and Postgres refuses that; the
  rule is enforced in the money server action and in `customStepDays`.
- The series is SHOWN, not just ruled: every obligation card carries its next
  three dates, and the drawer previews them while he types the rule.
  `nextObligationDates` produces both those dates and the anchor the calendar
  event is written on, so what he reads and what Google expands cannot drift.
- B4, rate per stream: `work_streams.hourly_rate`, nullable, edited in
  Settings > Work streams. `streamRateLine` (lib/money/rates.ts) puts each
  stream and its rate into the assistant's app context, and the hard rule now
  points at the stream's own rate instead of carrying one remembered number.
  A stream with no rate says "no rate recorded" rather than being given the
  floor silently. This stores one number and tells the assistant. There is no
  quoting, no invoicing and no time tracking, and m7b.test.ts fails if a tool
  grows one.
- Tests: `npm run test:m7b` (32 offline). app/dev-preview renders both money
  panels and the rate panel with mock data.
