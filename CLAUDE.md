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
  trips, and since B18 reply drafts saved in a mailbox's Drafts folder)
  execute immediately and are undoable; confirm (draft_email,
  send_email, propose_event_with_invites) only ever insert a proposed
  assistant_actions row. draft_email is in the confirm list because the
  executor has always turned it into a proposed send_email row, and G1/B11
  made the declared bucket agree with what happens; the M4 line that called
  it autonomous was stale from 1 September 2026 and is corrected here.
  Stub: gst wiki. There is no tool that mutates
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
- Mail-to-task (the 3 AM cron, and the scan_mail tool from a connector; the
  in-app Assistant tab button went with the chat in B24): per-account isolated model
  context whose only tool is propose_task. Gmail metadata format + snippet,
  Graph bodyPreview; bodies and attachments never fetched or stored. Mail
  text enters context inside fenceUntrusted (fixed data-not-instructions
  preamble + provenance). Output schema-constrained; external_ref must match
  a scanned message id; capped 5 proposals/account/day (was 20 until
  13 September 2026: the list filled with notices); deduped on external_ref. Tasks land source=email, and context rendering wraps
  source=email rows in the same untrusted framing.
- Scan feedback loop (found live 31 Aug 2026, fixed; do not regress): the
  7 AM brief was sent from ca_tapasnr to itself, so it landed in the inbox the
  3 AM scan reads (since B23, 29 Sep 2026, it goes to REPORT_ADDRESS
  tapas.r@mail.ca.in in lib/brief/send.ts; the belts below stay). The scanner re-filed the tasks the brief was reporting,
  one fresh copy per day, because each morning is a new message id and the
  external_ref dedup only catches the same message twice. lib/assistant/
  scan-filters.ts holds both belts, pure and tested in scripts/m5.test.ts:
  isAppGeneratedMail drops anything carrying the X-Life-OS header the brief
  now sets, or a self-addressed message whose subject starts with the brief
  prefix (for briefs predating the header); isAlreadyOpen refuses a proposal
  whose normalised title already matches (since B19: or nearly matches, see
  that section) an open task, or any task created in
  the last 45 days whatever its status, so a task he dropped does not return
  when a chaser arrives. Never widen the first
  to "ignore all mail from myself": mailing yourself a reminder must still
  become a task, and a test pins that. Third belt since 13 September 2026:
  isNoiseMail (same file) drops machine mail by sender and subject (bills,
  statements, alerts, bounces, codes, AGM notices) before the model sees it;
  the prompt says the same, and the live list had shown the prompt alone was
  not enough.
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
  and 24 optional parameters, and this tool set has 92 optional ones (147
  parameters in all, counted at M8; the number grows every milestone, so read
  the census rather than this line). Nothing
  in the security model depends on strict; lib/assistant/execute.ts validates
  every argument server-side and the approval gate is independent of it.
  scripts/m4.test.ts walks every schema, fails on any union, and records the
  parameter census. GET /api/assistant/health reports the live commit and
  that census.
- Model choice (B24: mail scan only): Settings > Mail scan model writes
  provider and model names into assistant_settings (scan_* columns; the chat_*
  columns are left in the table, unread, removable in a later migration);
  loadLlmOverride feeds them to runLlmTurn. Only names are stored: keys stay in the
  server environment. When Settings picks a provider other than
  LLM_PROVIDER, the generic LLM_BASE_URL / LLM_API_FORMAT overrides are
  ignored for that call, since they describe the env provider.
- GET /api/assistant/health (owner session) pings the scan model (B24: the
  chat role is gone). Settings has a Test button.
- The in-app chat, and with it the chat transcript (localStorage, then the
  assistant_chat_turns table in M7c/B6), was REMOVED in B24, 29 September 2026.
  The table stays in the database, unread; see the B24 section.
- MCP connector: POST /api/mcp (bearer LIFEOS_MCP_TOKEN, timing-safe compare,
  exempted from the cookie gate in proxy.ts because it authenticates itself)
  serves a manifest plus read and write ops. Write ops route through the same
  executeToolCall, so buckets, hashes and the queue behave identically for an
  outside model. Approve, reject, execute and undo are deliberately NOT on
  that surface. lib/assistant/actor.ts supplies the identity: cookieActor for
  the browser, serviceActor for token-authenticated callers. Task writes moved
  to lib/tasks/write.ts so all three callers share one implementation, with ONE
  deliberate exception: undoing a delete_task re-inserts the kept snapshot
  directly (lib/assistant/execute.ts), original id and all, because routing it
  through createTask would mint a new id and make the undo a copy rather than a
  reversal. It restores priority_source and priority_reason verbatim, so the
  B3 rule is honoured by restoring his hand rather than by re-deciding it. The
  server itself lives in mcp-server/ (its own package, excluded from the Next
  tsconfig and eslint; stdio transport, and it fetches its tool list from the
  app so it cannot drift).
- create_task (chat and both connectors) refuses a title that is already an
  open task, naming the existing id, since 13 September 2026: a project chat
  that plans his week twice was adding the same rows twice. Since B19 a NEAR
  duplicate is refused too (see the B19 section).
- Tool surface (33 registry tools since B26, shared by the in-app assistant and both
  connectors, which serve the 32 that are not stubs; the connectors also serve
  24 read tools, counted from MCP_READ_TOOLS): create/update/delete
  for tasks, notes, people, obligations and
  finance items; add_project only, with no update or delete for a project;
  create, update and log for trips; solo calendar events including edit and delete
  (delete_event refuses anything with source other than 'app', so a synced
  event is never removed); draft_email; save_reply_draft (B18); scan_mail;
  undo_action; reject_queued_action. Fourteen read tools on both connectors:
  twelve mirror the writable data, so nothing writable is invisible; the
  twelfth of those is the B15 house-rules tool, which mirrors nothing
  writable because nothing here writes a persona; and B18 added two mail
  reads, lifeos_list_inbox and lifeos_read_mail_thread. send_email and
  propose_event_with_invites stay confirm-bucket,
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
- Tests: npm run test:m4 (67 offline, the R6 red-team controls, the four
  G1 governance controls and the B15 persona class). rls.test.mjs adds
  audit_log append-only and payload-immutability trigger proofs.

## Travel Desk (Milestones 6 and 6d)

- Schema: trips and trip_expenses shipped in M1. Migration
  20260828000100_m6_travel_desk.sql added the status trail ('underway',
  'billed'; 'booked' and 'cancelled' stay valid). Migration
  20260901000300_m6d_invoice_feed.sql replaced trips.billable_to (free text)
  with trips.bills_to, enum trip_bills_to: icai_monthly (the default),
  chapter_aed, none.
- The bills and billing_profile TABLES, and the bill_recipient and bill_status
  enums, were dropped in M8 (migration 20260901000800). Nothing had read or
  written them since M6d. Do not reintroduce them: see "Billing: what this app
  does NOT do" below.
- receipt_ref stays a reference string. There is no upload path, no storage
  bucket and no attachment UI anywhere in this module, and scripts/m6.test.ts
  fails if any tool grows a file-shaped parameter.
- lib/trips/core.ts is the pure trip logic: transport modes, leg parsing, the
  billable rollup, the date labels and the session line. It was called bill.ts
  until M8, which had not been true since M6d emptied it of bills.
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
- Tests: npm run test:m6 (29 offline). app/dev-preview renders the trips
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
- B30 records billing state only; still no invoice, number, total or Zoho call.

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
  tokens flip and the ~44 `dark:` classes do not. Do not remove it.
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
  rollUpTrips, so they cannot drift. Since 13 September 2026 all three load
  the steps through lib/tasks/trip-steps.ts loadTripSteps (trips ended within
  30 days or not yet ended, then their steps, two plain queries) instead of
  each running its own unbounded PostgREST embed. The brief cron also runs
  staleTripStepIds first and drops (never deletes) any open step whose trip
  ended more than three days ago, audit action trip_steps_swept; before that
  a finished trip's "Book return ticket" ranked as urgent for ever. A rollup row inherits the priority and
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
  createTrip when with_checklist is set. Since 13 September 2026 it never
  writes a step whose title the trip already carries, so the trip screen's
  "Add checklist" cannot add a second set. The add-trip drawer defaults it on,
  the connector tool defaults it off, and both go through that one function.
  A chapter_aed trip additionally seeds the AED step alone (scope
  'aed_only') even when the checklist was declined.
- create_task and update_task take an optional trip_id, so the assistant and
  both connectors can attach travel admin to a trip (including the 36 tasks
  already in the live database). lifeos_list_trips returns checklist_done and
  checklist_total. No new tool, no bucket change, no new approval path.
- Tests: npm run test:m6b (34 offline tests: rollup counts and rank
  inheritance, the city in the label, checklist date derivation and the
  past-date clamp, the chapter_aed reminder, the brief ranking the same rows,
  and the tool-schema rules).

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
- Tests: npm run test:m6c (22 offline tests: the four checklists, the
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
  one line when that is 60% or more of at least five open tasks, pointing
  him to Claude ("Review my task priorities"; the in-app link went with the
  chat in B24). No batch UI and no scheduled re-prioritising:
  a chat pass is a conversation he can argue with, which is the point.
- Tests: npm run test:b3 (20 offline).

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
  carries a ToolDisclosure: none, app_data, mail_metadata or mail_body, and
  since B15 also persona (see that section: Tapas approved the fifth member by
  name on 1 September 2026). There
  is deliberately NO member for document content, so a tool reading a Drive
  file or an O365 attachment could not be given a valid class. The type is
  DERIVED from TOOL_DISCLOSURES, so widening the union means editing that
  list, and the test that reads the list fails when a sixth member appears.
  Do not add one without asking Tapas. A boot-time check in tools.ts throws
  on a registry that drifted past the compiler.
  Enforcement: scan_mail is the only mail_body tool in the registry (Gmail
  snippets and Graph bodyPreview are body text, whatever the tool description
  says), and checkDisclosure refuses it when it is reached inside another
  tool's execution. Since B18 the two connector mail reads are mail_body as
  well; they are read tools, served by runReadTool and never reached inside
  executeToolCall, so the nesting gate has nothing to catch there, and every
  call is audited instead (see the B18 section). Nesting is tracked with AsyncLocalStorage in execute.ts, not a
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
- sessionLine() and travelDiffersFromSession() in lib/trips/core.ts are pure
  and drive the card: "L1D2 - 4 Sept - Bangalore" leads, the descriptive
  title sits under it, and the travel span is labelled "Travel ..." and only
  shown when it says something the session date does not (a day return
  would just repeat itself). A trip with neither field reads exactly as it
  did before.
- Both fields are on create_trip and update_trip, so a schedule import fills
  them. `prompts/RECIPE-aica-schedule-intake.md` carries the mapping; it lives
  in the project folder, not in this repo.

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
- Tests: `npm run test:m7b` (34 offline). app/dev-preview renders both money
  panels and the rate panel with mock data.


## Brain, health and one chat thread (M7c: B5, B6)

Migration `20260901000700_m7c_brain.sql`. Additive, nothing dropped. NOT
applied to the cloud database.

- `/brain` was a placeholder while the assistant and both connectors had been
  writing `notes` and `people` since M4, so rows had been landing where he
  could not see them. It is now two tabs: Notes and People.
- Notes: newest first, a search box, and a drawer to write or edit one.
  `lib/brain/notes.ts` is the pure part (`searchNotes`, `newestFirst`,
  `notePreview`, `noteDateLabel`). Search is one haystack of title plus body,
  every word must appear, and it runs in the browser over the whole list.
  ponytail: hundreds of rows, not millions; move it into Postgres only if
  that read ever becomes the slow part of the page.
- `notes.task_id` and `notes.trip_id` are new, both `on delete set null` (the
  house rule for loose links: deleting a task or a trip must never destroy
  the note that recorded what happened in it). A reference is only worth
  showing if it can be followed, so the task, the trip and each person are
  links. The work stream stays a plain label because there is no screen for
  one stream.
- There is no page for a single task, so `/tasks?task=<id>` opens that task's
  drawer on arrival. An id matching nothing opens nothing.
- People: name, role, organisation and how he knows them, with `unverified`
  shown plainly and a one-tap Confirm that clears it. That flag is what the
  approval queue highlights before a send, so a directory he has actually
  curated is what makes the warning mean something. A record he TYPES is born
  confirmed, and editing one confirms it (reading it and deciding it is right
  is the whole act); only the assistant's `add_person` still writes
  `unverified: true`, which is the unchanged A5 control. Confirm and edit both
  revalidate `/assistant` so the old warning does not stay on screen.
- CONFIDENTIAL BOUNDARY: a note holds his own words and reference strings.
  No attachment, no upload, no storage bucket and no file-shaped column or
  tool parameter anywhere in this module. `scripts/m7c.test.ts` fails if one
  appears.

### B5, health as something the app protects

- A `Health` work stream, seeded by the migration for the existing owner and
  added to `seed_new_user` for any future first sign-in. `kind` is
  `'personal'` rather than a new enum member on purpose: nothing reads that
  column, and Postgres refuses to use an enum value in the same transaction
  that adds it, which would cost a second migration to buy one word on
  Settings.
- Existing Personal tasks are deliberately NOT moved. Which of them is health
  work is his judgment, not a string match on a title, and the test fails if
  the migration ever grows an `update tasks`.
- The day after a full-day session (persona inferred item 5).
  `lib/health/recovery.ts` is pure: `sessionDayKey` prefers `session_date`
  over `end_date` (M7d: the teaching day is often neither the start nor the
  end of the travel), cancelled trips never count, and `recoveryLine` returns
  null when there is nothing to say.
- It is an OBSERVATION, and that is the whole design. It declines nothing,
  moves nothing and writes no calendar entry to hold time: the same shape as
  the weekend guard. The test forbids `createEvent`, `syncTaskReminder`,
  `writeReminder`, `supabase`, `.insert(` and `.update(` in that module.
- Two surfaces read the same function so they cannot disagree: a card on Home,
  and one line in the assistant's app context. The corrective duty is in
  `HARD_RULES` (above the persona, so the A9 precedence proof still holds):
  file health work in the Health stream, raise what has sat untouched, and
  say the day after a session is worth protecting, as an observation only.

### B6, the chat thread in the database

- `assistant_chat_turns` replaces the `life_os_assistant_chat_v1`
  localStorage thread M4 shipped, so the same conversation is on his phone
  and his laptop.
- `seq bigint generated always as identity` is the order, NOT `created_at`: a
  user turn and its reply are inserted in one statement and would share a
  `now()`, which would leave the thread's order down to luck.
- OWNER SESSION ONLY, and this is the sensitive part. The transcript is his
  own words about his own work, which puts it in the persona's class. RLS
  covers the browser role; `revoke all ... from service_role` covers the
  connectors, which reach the database as `service_role` and are therefore
  not scoped by RLS at all. No tool reads it, none may be added, and
  `scripts/m7c.test.ts` fails if any tool surface names the table, imports
  the store, or grows a tool or parameter whose name looks like a transcript.
- `lib/assistant/chat-history.ts` is the pure part: `KEEP_TURNS` is 40,
  `idsToTrim` returns everything past the newest 40, and `sanitizeTurns`
  treats what a device hands back as data (roles checked, content capped at
  8000 characters, tool chips capped, the thread capped at 40).
- It TRIMS, and trimming DELETES. There is no `hidden`, `archived` or
  `deleted_at` column to hide behind, and New chat is a real delete: a thread
  he ended must not still be readable from the other device.
- `loadChatTurns` reads newest-first with `.limit(KEEP_TURNS)` and only when
  the chat tab is the one being rendered, so a year-old thread is never read
  in full on a visit to the Queue.
- The move off localStorage runs once, in the browser, on first load after
  deploy: it posts whatever the device holds, the server takes it ONLY into
  an empty thread (merging two orderings of one conversation produces a third
  conversation that never happened), and the local key is removed either way.
  Nothing writes that key any more.
- Tests: `npm run test:m7c` (39 offline). app/dev-preview renders the notes
  and people panels and the recovery-day card with mock data.

## Closeout (M8)

Two migrations, `20260901000800_m8_drop_billing_remnants.sql` and
`20260901000900_m8_persona_refresh.sql`. No new screen, no new tool, no new
column.

- The GST wiki hook, `lookup_gst_wiki`, is present and INACTIVE by design:
  bucket `stub`, disclosure `none`, and one fixed sentence saying the wiki is
  not connected. An inactive stub reads nothing, which is why `none` is the
  honest class; connecting the wiki later needs a class Tapas approves by
  name, and that is a decision rather than a diff.
  `scripts/m8.test.ts` is what keeps that true: the registry module imports
  nothing at all, the executor answers a stub before it builds an owner client
  and without awaiting anything, no shipped file outside the registry may even
  name the tool, and the tool carries no parameter that could address a URL,
  a path or a file. Routing is by tool NAME (B11), so a hostile argument still
  lands on the same sentence.
- The quarterly persona refresh is one recurring task in the Personal stream,
  `recurring_rule` 'monthly:3' on the M1 machinery, first due on the first day
  of the next quarter at 09:30 IST. `reminder_mode` is 'calendar': four
  entries a year is not the clutter M7a removed, and this is the same case as
  the chapter AED invoice step, rare enough that nothing else in his week
  raises it. Priority is 'medium', not 'high', because B3 makes a seeded row
  count as his own hand and a permanent 'high' would dilute the Do-first band.
  SQL cannot call Google Calendar, so the migration also writes the `reminders`
  row in the pending state (`channel` 'gcal', `created` false) the writer
  already uses when ca.tapasnr is unreachable; `retryPendingReminders`, which
  runs on every calendar sync, then creates the event.
- The M6d debt is cleared: `lib/trips/bill.ts` is now `lib/trips/core.ts`, and
  the `bills` and `billing_profile` tables, the `bill_recipient` and
  `bill_status` enums and the `billing_profile` insert in `seed_new_user` are
  dropped. The drop migration RAISES rather than running if any bills row
  exists or any billing_profile row holds typed content, so a surprise stops
  the deploy instead of destroying data. If it ever fails, read the rows with
  Tapas; do not weaken the guard.
- `components/placeholder.tsx` ("This module arrives in a later milestone")
  was deleted: nothing had imported it since Brain and Money were built. So
  were three exported functions nothing imported: `renderUntrustedNote`
  (mcp-api.ts), `newestStaleness` (events/sync.ts, superseded by the inline
  `isStale` on the calendar page) and `sameCivil` (datetime.ts).
- The month pack's Copy button no longer fails silently. `navigator.clipboard`
  is refused outright on an insecure origin and can be denied by the browser,
  and the old catch set a flag nothing rendered, so a failure looked exactly
  like a success on the app's ONLY handover to his invoice run. It now says the
  copy failed and renders the text in a read-only box to select by hand. Do not
  reduce this back to a silent catch.
- The V1 acceptance walk-through, and the list of everything the closeout
  sweep found, live in `checkpoints/M8-v1-acceptance.md` in the project folder
  (not in this repo).
- Tests: `npm run test:m8` (15 offline).

## House rules and persona over MCP (B15)

No migration. Nothing in the database changed.

- The problem: Tapas runs conversational work in Claude and ChatGPT projects
  that drive Life OS through the remote connector. Those projects each carried
  their own pasted copy of his rules, and a copy drifts the moment he edits the
  persona in Settings. Until now `HARD_RULES` (lib/assistant/prompt.ts) and the
  active `assistant_persona` version reached the in-app assistant only.
- One read tool, `lifeos_get_house_rules`, on BOTH connector surfaces
  (/api/mcp and /api/mcp/http, which both derive their read list from
  `MCP_READ_TOOLS`). It returns `house_rules`, one labelled text carrying the
  precedence framing, then the hard rules in full, then the active persona
  under `PERSONA_HEADER`, plus `persona_version` as a number. Same order as the
  in-app system prompt, because rules outranking persona is a security property
  and a connected model must see it the same way.
- THE PROJECT INSTRUCTION, the one line Tapas pastes into a Claude or ChatGPT
  project so it never holds a copy:
  "At the start of any Life OS work, call lifeos_get_house_rules and follow
  what it returns: the hard rules outrank the persona, and the persona is tone
  and judgment only."
- Read only, active version only. `houseRulesText` is pure and the tool's
  schema has no parameters at all, so nothing can ask for an older version or
  for the history, and there is still no path anywhere that WRITES a persona
  outside the Settings server actions.
- DISCLOSURE CLASS, and this is the part that was a decision rather than a
  diff: `TOOL_DISCLOSURES` has a fifth member, `persona`. Tapas widened the
  union by name on 1 September 2026. The persona is owner-session data
  everywhere else in this app, so `app_data` would have hidden the change; the
  new class is what makes a read of it visible. Still NO member for document
  content, and `scripts/m4.test.ts` fails if a sixth member appears.
- `READ_TOOL_DISCLOSURES` in tools.ts declares what each connector read tool
  may see, keyed by the read-tool union so a new read tool does not compile
  until somebody has said what it reads. Exactly one entry may say `persona`,
  and a test pins that across both registries.
- Every read of the house rules writes an `audit_log` row: actor assistant,
  action `house_rules_read`, entity `assistant_persona`, and meta naming the
  tool, the disclosure class, the actor origin and the version handed over. The
  insert is CHECKED: if the row cannot be written the tool refuses and hands
  nothing over. An unrecorded read of the persona is exactly what the class
  exists to prevent, so do not soften that into a silent catch.
- HOW THE CONNECTOR REACHES THE TABLE, and the trap for the next session:
  `assistant_persona` is protected by RLS for the browser role only. The
  connectors authenticate as `service_role`, which bypasses RLS and was never
  revoked on that table, so no grant or policy change was needed and no
  migration was written. Do NOT add a
  `revoke all on table public.assistant_persona from service_role` on the
  m7c pattern: that revoke is right for `assistant_chat_turns`, whose sensitivity
  m7c compared to the persona's, and it would silently break this tool. If that
  boundary is ever closed again, remove the tool in the same change.
- `loadActivePersonaRow` in lib/assistant/context.ts is the one query for
  "which version is live", so the in-app prompt and the connector cannot
  disagree about it. `loadActivePersona` is now a thin wrapper on it.
- Tests: four in `npm run test:m4` (63 to 67).

## Inbox, threads and reply drafts over MCP (B18)

No migration. Nothing in the database changed: `assistant_actions.kind` is
free text and `audit_log.meta` has always been jsonb.

- The problem: Tapas runs an "AI workforce" in Claude Code (the AKM Agents
  folder) whose 2 PM inbox triage sorts his mail into needs you, drafted,
  hand to an agent and noise, and saves replies as drafts he sends himself.
  Claude holds one Gmail account of its own (his ICAI mailbox), so his other
  three mailboxes are reached through Life OS, which already holds their
  OAuth. Until B18 Life OS could only turn mail into proposed tasks.
- Three mailboxes only: taxstrategia (Google Workspace), altechon (Microsoft
  365, Graph) and ca_tapasnr (Gmail). `MAIL_SLOTS` in tools.ts is that list.
  The icai slot has none of these tools, the enums leave it out, and
  `checkMailSlot` refuses it by name.
- Tapas approved two changes by name: (1) the M4 rule "nothing appears in the
  Gmail drafts folder before approval" is reversed FOR REPLY DRAFTS ONLY
  (draft_email still stores in the app and nowhere else); (2) full bodies of
  these three mailboxes may reach an outside model through the connector,
  under the existing `mail_body` class. `TOOL_DISCLOSURES` still has five
  members and scripts/m4.test.ts still fails on a sixth.
- All provider logic is in `lib/assistant/mailbox.ts`: pure, dependency
  injected (a request function), relative .ts imports only, so the offline
  suite loads it directly. `mailRequest` in lib/assistant/mail.ts is the
  server wiring: the same withResourceAuth path as every other resource call.
- `lifeos_list_inbox` (read, both connectors): account, optional since (ISO
  date read as IST, default three days), max (default 25, cap 50),
  unread_only. Per message: id, thread_id, from, to, cc, subject, date (ISO
  UTC), snippet, unread, has_attachments, attachment names and sizes, and
  `untrusted: true`. Gmail lists `in:inbox` then fetches each message with a
  `fields` mask that asks for part names and sizes and never part data; Graph
  reads `me/mailFolders/inbox/messages` with a `$select` and lists
  attachments with `$select=name,size`. The app's own X-Life-OS mail is left
  out through `isAppGeneratedMail` (lib/assistant/scan-filters.ts).
- `lifeos_read_mail_thread` (read, both connectors): account and thread_id.
  Each message's from, to, cc, date, subject and plain-text body (HTML
  converted, quoted history trimmed, 8,000 characters a body and 30,000 a
  thread, the budget spent newest first), attachment names and sizes only,
  `untrusted: true` on every message. Drafts in the thread are not part of it.
  Graph is asked for text (`Prefer: outlook.body-content-type="text"`), with
  htmlToText as the belt.
- DISCLOSURE: both reads are `mail_body` in `READ_TOOL_DISCLOSURES`. The brief
  asked for `mail_metadata` on the list; it returns snippets and Graph body
  previews, which the B8 rule above says are body text whatever a description
  calls them, so the honest class is `mail_body`. Exactly one entry still
  says `persona`.
- AUDIT: every call to either read writes an `audit_log` row BEFORE anything
  is handed over: actor assistant, action `mail_thread_read` or
  `mail_inbox_read`, entity the account slot, entity_id the account id, meta
  naming tool, disclosure class, actor origin and message count. Never a
  subject, a sender or a body. The insert is CHECKED (the B15 pattern): if the
  row cannot be written the read throws and returns nothing. Do not soften
  this into a silent catch. Bodies are never written anywhere else.
- `save_reply_draft` (registry, autonomous, disclosure `mail_metadata`, so
  both connectors and the in-app assistant get it through executeToolCall):
  account, thread_id, body, optional reply_all. Recipients, subject and
  attachments are NOT parameters, and `checkReplyDraftInput` refuses any of
  them by name before the thread is even looked up. Recipients are derived
  from the last non-draft message: reply goes to its sender, reply all adds
  its To and Cc, his own address always removed; when he sent the last
  message himself the reply goes to the people he wrote to (what Gmail and
  Outlook do). Subject "Re: ...". Gmail: `users.drafts.create` with threadId,
  In-Reply-To and References. Graph: createReply or createReplyAll, then one
  PATCH with the body and the derived recipients; if the PATCH fails the
  empty shell is deleted.
- NO X-Life-OS HEADER ON A DRAFT, in either dialect, and do not add one. When
  Tapas sends the draft every header goes with it: the stamp would tell his
  clients a tool drafted the mail, and isAppGeneratedMail would make the
  inbox list and the 3 AM scan skip his own sent reply. The brief keeps its
  stamp and isAppGeneratedMail is unchanged. scripts/b18.test.ts fails if a
  draft's MIME carries the header or mailbox.ts writes one.
- ONE thread_id PARAMETER, not thread_id plus conversation_id. For altechon
  its value is the Graph conversation id, which lifeos_list_inbox returns as
  thread_id. A parameter named conversation_id would trip the m7c rule that
  no tool parameter may look like a chat transcript, and that rule is worth
  more than the second name.
- B10 for the draft: `TOOL_TARGETS.save_reply_draft` is the thread. A thread
  the provider does not have, or an account that is not connected, downgrades
  to the queue like any other unresolved target; the stored payload there,
  and on the executed row, drops the reply text (`storedDraftPayload` keeps
  body_chars only). The draft lives in the mailbox, not in this database.
- Undo (`undo_action`, and the History tab): deletes ONLY the draft this tool
  created, the delete_event rule. Ownership is proved by the record, never by
  a header: the draft id and the version it was left at are written on the
  executed assistant_actions row when the draft is made (the id also on the
  audit row), and undo takes both from that row, never from the caller. No
  recorded version, no delete. The provider is then asked: a Gmail draft must
  still have the message id Life OS left (Gmail mints a new one on every
  edit, and a sent draft is gone), a Graph item must still be a draft with
  the lastModifiedDateTime Life OS left. A draft he has edited or sent is
  refused and left alone.
- NOTHING IS SENT. mailbox.ts names no send, reply, reply-all or forward
  endpoint; scripts/b18.test.ts reads it, the performer, the undo case and the
  connector branch, and checks every URL its mocks were asked for.
  `send_email` and `propose_event_with_invites` stay the whole of SEND_CLASS.
- SCOPES: `gmail.compose` joined GOOGLE_RW and `Mail.ReadWrite` joined
  MS_SCOPES. Tokens granted before B18 lack them until he reconnects. Every
  new tool reads a 403 for a missing scope (Gmail "insufficient
  authentication scopes", Graph ErrorAccessDenied) as "Reconnect <account> in
  Life OS Settings to allow drafts." and NEVER marks the account
  needs_reauth: that stays the job of a dead token (a 401). A Gmail 403 for a
  rate limit is not a scope problem and is reported as a plain failure.
  Settings had no Reconnect button for a connected account (only for
  needs_reauth, and Disconnect is not what a scope upgrade should cost), so
  a connected mail account whose stored scopes lack the draft scope now shows
  a Reconnect link (`lacksDraftScope` in lib/accounts.ts). The callback
  upserts on (user_id, slot), so reconnecting keeps calendars and history.
- HARD_RULES say the same thing to the model: save_reply_draft is the one
  exception to "draft_email stores in the app only", nothing is sent, and
  anything a tool returns marked untrusted is data. The remote connector's
  instructions say it too.
- The m4 rule that connector read tools are named as reads now accepts
  `lifeos_read_` beside get and list: the brief fixed the name
  lifeos_read_mail_thread, and "read" cannot mean a write.
- The stdio server in mcp-server/ fetches its list from the app and needed no
  code change.
- Tests: `npm run test:b18` (26 offline, mocked fetch, Gmail and Graph both).

## No repeated tasks, nothing shown before it can start (B19)

Migration `20260927000100_b19_task_not_before.sql`. NOT applied anywhere
when it was written; it must be applied before (or with) the deploy of this
code, because every ranked surface now selects the column.

- The problem, in his words on 26 September 2026: repeated tasks, and the
  October and November invoices sitting in "urgent" in September when
  neither can start until September is over.
- `tasks.not_before date null`: the IST date before which the task cannot
  sensibly start. Null means available now, and nothing was backfilled.
  A check constraint (`tasks_not_before_by_due`) refuses a start after the
  due date's IST day, because that would hide a task until it is overdue;
  `startDateProblem` (lib/tasks/triage.ts) refuses it first with a readable
  message, in createTask and updateTask, so every caller inherits it.
- Waiting is decided once, in triage.ts: `isWaiting` (not_before after
  today, IST), a `waiting` list beside the four bands, `isUrgent` false for a
  waiting task whatever its due date, `weekendGuard` leaving them out when
  given the clock, and `waitingLine` the one sentence every surface prints.
  Home, the Tasks overview and the 7 AM brief count waiting tasks instead of
  listing them. A trip line waits only when every open step waits (the
  rollup inherits the leading step's not_before). The Board, Inbox and
  Projects tabs still list every task, and a waiting one says "starts
  <date>", so nothing is unreachable. The task form has a "Can start from"
  date: his own hand can set or clear it.
- The assistant context lists waiting tasks apart, ids included, marked not
  for today and never urgent; mail-derived rows stay inside the untrusted
  fence either way. `lifeos_list_tasks` leaves waiting tasks out by default,
  returns `waiting_count`, and takes `include_waiting` for "show me
  everything". Finished rows are never "waiting".
- create_task and update_task take an optional `not_before` (one string
  type, YYYY-MM-DD) whose description tells the model a month's invoice
  starts after that month ends and next month's work is never urgent this
  month. Undo restores it; a pre-B19 snapshot without the key leaves it alone.
- Recurring spawn: `nextOccurrence` (lib/tasks/recurring.ts) gives the next
  due date and `not_before` = the first day of the calendar period (day,
  Monday week, month, year) its due date falls in. For the monthly invoice
  due on the 3rd: the occurrence covering October is due 3 November and waits
  until 1 November. The spawner in lib/tasks/write.ts writes both through
  that one function.
- Near duplicates: `lib/tasks/near-duplicate.ts`, pure and import-free.
  Lower case, punctuation gone, month abbreviations spelled out, stop words
  dropped; period tokens (months, four-digit years, Q1 to Q4) must agree
  exactly or the titles are different work; otherwise Jaccard word overlap,
  refused at 0.8 or more. create_task (chat and both connectors) refuses
  against every open task, waiting ones included, and names the id to
  update; a step attached to one trip is not compared with another trip's
  steps. The mail scan's isAlreadyOpen uses the same score. His own form is
  never refused.
- `scripts/report-premature-tasks.ts` (`npm run report:premature`, which
  reads .env.local): one select, prints open tasks naming a future month or
  year and near-duplicate pairs for him to review. It writes nothing, and
  b19.test.ts fails if an insert, update, upsert, delete or rpc appears in it.
- Tests: `npm run test:b19` (20 offline).
- B27 (30 September 2026, no migration): finding the email behind a task, and
  searching. `lifeos_read_mail_thread` now takes EITHER `account` plus
  `thread_id` OR one `message_ref` (a task's `external_ref`, like
  `gmail:ca_tapasnr:<message id>` or `graph:altechon:<id>`); both or neither is
  refused, and an icai ref is refused by name. The thread is found from the
  message id (Gmail `users.messages.get` with `fields=threadId`, Graph
  `conversationId`) in lib/assistant/task-mail.ts, pure and dependency
  injected like mailbox.ts, through the same `mailRequest` path. The audit row
  is unchanged. `lifeos_list_inbox` gained optional `query` (a string, at most
  200 characters): Gmail `q` over ALL mail, archived included, and Graph
  `$search` over the whole mailbox (Graph refuses `$filter` and `$orderby`
  beside `$search`, so `since` and `unread_only` are applied after the
  search). With a query and no `since` all time is searched, because the
  default three days would hide exactly the older mail a search is for; the
  reply's `since` is then null. The query text is never audited. `max`, the
  fields, the untrusted marking and the audit row are as before.

## Mail scanner quality (B20)

Migration `20260927000200_b20_mail_scanner_quality.sql`. NOT applied anywhere
when it was written; apply it before (or with) the deploy of this code, since
the scan and the brief select its columns. Nullable additions only:
`tasks.external_thread`, `tasks.source_key`, `tasks.lapses_on`,
`work_streams.scan_hint` (check: at most 200 characters), plus hint seeds by
stream name that never overwrite a hint already written. Health gets none.

- Boilerplate: SCAN_SYSTEM says footers, signatures and disclaimers are never
  actions, and `matchesNeverExtract` (scan-filters.ts, a constant phrase list
  seeded with "boarding pass") drops a proposal that matches. The audit row
  records the phrase only.
- Tickets: `isTicketSender` allowlists traveldesk@icai.in and
  etickets@sharpmail.in (the ICAI travel desk and its booking agent, confirmed
  from a real email on 27 September 2026) and the domains irctc.co.in,
  goindigo.in, airindia.com/.in, airvistara.com and akasaair.com. Their mail
  is exempt from isNoiseMail and NEVER goes to the task pass: the travel
  desk's body is only a covering note and the boarding-pass footer, and the
  tickets are PDF attachments.
- PDF tickets, and this crosses the old "no attachments" line on purpose, at
  the orchestrator's request relaying Tapas's review: for allowlisted senders
  only, mailbox.ts `readTicketMail` reads the body and up to 3 attachments of
  mime type application/pdf, 2 MB each (bigger ones are never downloaded),
  and `lib/assistant/pdf-text.ts` extracts at most 6,000 characters of text in
  memory with unpdf (MIT, zero dependencies, a serverless pdf.js build). No
  OCR. readTicketMail refuses any other sender itself, before any provider
  call. The text goes, fenced as untrusted, only to the isolated ticket turn
  (TICKET_TOOL, propose_trip_leg), with each file name's airport codes read
  as a route (`routeFromName`, PLACE_CODES in lib/trips/ticket.ts). It is
  stored nowhere: only the leg fields (from, to, date, mode, ref) are
  written. No disclosure class was added (still five); the scan stays
  mail_body. gmail.readonly already covers attachments.get, so no scope
  changed.
- lib/trips/ticket.ts validates (scanned ref, a trip whose dates cover the
  day give or take 2, no duplicate leg, 10 legs a night across accounts) and
  execute.ts `logScannedTripLeg` writes through the log_trip_leg performer,
  storing the PNR as the leg's optional `ref` jsonb key (no migration), and
  sets an empty billable transport expense's receipt_ref to
  `email:<message ref>` in the same action; one undo reverses both. Tickets
  usually arrive before the trip exists: an unmatched leg is kept in the
  scan's audit row as cities and date only (never the PNR) and the brief says
  "1 ticket (Mumbai to Kolkata, 25 Sept) has no trip yet". A ticket email
  whose PDFs gave no text is counted as "could not be read", with the route
  from the file name when it has one. An unlogged ticket is read again the
  next night while it is inside the 3-day window, so it lands once the trip
  exists.
- THE CONTENT RULE (widened by B21): a mail's body text and its PDF
  attachments may be read for the ticket and cab-receipt allowlists only
  (`isTicketSender`, `isCabReceiptSender`, joined in `mayReadMailContent`,
  which readTicketMail checks itself), approved by Tapas by name on
  27 September 2026. No other sender, ever. Adding a sender to either list is
  a decision for Tapas, not a diff. That rule is for the SCAN. Since B22 there
  is one more reader, outside the scan (lifeos_read_mail_attachment, see the
  B22 section):
  "any attachment, one at a time, only when Tapas or his agent asks for that named attachment, approved 28 September 2026".
- Repeats: the scan fetches Gmail threadId and Graph conversationId, and
  `dropKnownMail` drops, before the model, mail whose thread has an open task
  or one from the last 45 days, and mail whose sha256(sender, normalised
  subject) matches a task from the last 14 days or an earlier mail in the
  same batch. The model is shown up to 40 open titles, fenced. isAlreadyOpen
  gained `sameDistinctThing` (shared document code, batch number or
  counterparty name; months still decide), in the scan only.
- Lapse: `tasks.lapses_on` is for windows (early bird, RSVP, e-vote, event
  day), never a statutory, client or payment date. propose_task, create_task
  and update_task take it. The brief cron drops open tasks whose lapses_on is
  before today (lib/tasks/lapse.ts), one `lapse_tasks` assistant action
  (undoable, History tab included) and one `tasks_lapsed` audit row of ids,
  and the brief says "3 closed windows dropped". A task without lapses_on is
  never touched. `npm run report:lapsed` (reads .env.local, writes nothing)
  lists older mail tasks that look like closed windows.
- Streams: the scan hands each stream's scan_hint beside its name, judges by
  topic with the mailbox as tie-break, and never files professional mail in
  Personal. Settings > Work streams edits the hint. create_task and
  update_task refuse an unknown stream name with the real list
  (lib/tasks/stream.ts); update_task can now move a task's stream, and undo
  restores it.
- Tests: `npm run test:b20` (38 offline, synthetic ticket texts, and one real
  unpdf extraction of a hand-built PDF).

## Cab receipts on AICA trips (B21)

No migration. `assistant_actions.payload` and `audit_log.meta` are jsonb, and
the expense row is the existing trip_expenses shape.

- The problem, in his words on 27 September 2026: local cab rides on AICA
  trips are billable to ICAI and need a receipt each in the monthly invoice
  pack, and he collected them by hand. He approved reading receipts from
  Uber, Ola, Rapido and Bharat Taxi by name, on B20's terms.
- Senders: `CAB_RECEIPT_SENDERS` in scan-filters.ts, a separate list beside
  the ticket one. Domains (subdomains included): uber.com, olacabs.com,
  rapido.bike, rapido.co. One exact address: no-reply@bharattaxiapp.com
  (confirmed by Tapas from a real email). The three domains were not yet
  checked against a real receipt in his mailbox; narrow a domain to an
  address once one is seen. Exempt from isNoiseMail; never a task.
- Reading: the B20 reader (`readTicketMail`, 3 PDFs, 2 MB each, 6,000
  characters, unpdf, no OCR). `cabReceiptMail` hands the model the PDF text,
  or the body only where no PDF gave text (Uber's receipt is its body).
  Fenced as untrusted, to an isolated turn whose one tool is
  `propose_cab_expense` (date, time IST, provider, short from and to area,
  amount, booking id at most 40 characters). The sender decides the
  provider; a proposal naming another is refused. `cleanArea` keeps the part
  before the first comma and drops anything with four digits in a row.
- lib/trips/cab.ts validates: a trip within 1 day of the ride (`tripForDate`
  from ticket.ts, slack 1), no duplicate (same trip and provider and booking
  id, or same trip and amount within 10 minutes, against every earlier
  scanned ride, undone ones included, and the same run), 20 rides a night
  across accounts. A ride matching no trip is PERSONAL: nothing is stored,
  not even a rejection reason; the audit row carries a count
  (`cab_rides_personal`) and the brief never mentions it. This is a privacy
  rule, not an oversight.
- Bharat Taxi: its invoice can cover a date range with one total. The model
  proposes one ride per line with its own date; a Bharat Taxi mail that
  yields no well-formed ride counts as "could not be split" in the audit row
  and the brief, and nothing is added from it.
- Write: execute.ts `logScannedCabExpense` goes through the add_trip_expense
  performer: category transport (the existing enum value for all travel),
  billable true, `receipt_ref` = `email:<message ref>`. One
  assistant_actions row per ride, kind add_trip_expense, titled "Cab receipt
  from mail: Uber, Airport to Hotel" (trip_expenses has no description
  column; the History tab shows the title), payload the expense fields only
  (`cabActionPayload`). Undo is the existing add_trip_expense undo: the
  expense is deleted. A receipt already recorded, or recorded and undone, is
  not read again.
- Brief: "4 cab receipts added to the Kolkata trip (Rs 1,240)." from the
  scan's `cab_added_by_trip` (the trip's first city, else its title).
- Month pack: unchanged. A ride carries a receipt_ref, so it is never a gap.
  The app still builds no invoice.
- Tests: `npm run test:b21` (16 offline, synthetic receipts, one real unpdf
  extraction).

## Connector completeness (B22)

Migration `20260928000100_b22_brief_store.sql` (the `briefs` table). NOT
applied anywhere when it was written; apply it before (or with) the deploy of
this code, since the brief cron writes to it. Additive only.

- The problem: a 28 September 2026 audit found app capabilities the MCP
  connector (and so the AI workforce in `Agents/`) could not reach. Every tool
  below is on both connectors (`/api/mcp`, `/api/mcp/http`) with the
  `lifeos_` prefix (the in-app chat this once also covered was removed in B24).
- New write tools, all in the registry (lib/assistant/tools.ts), autonomous,
  disclosure app_data, a B10 target each where they take an id, and an undo
  each: `update_trip_expense` (receipt_ref, billable, amount, date, category;
  trip_expenses has NO description column, so there is none to change),
  `update_project` (name, work_stream, status, note), `update_work_stream`
  (scan_hint, hourly_rate, by stream name; the same check as Settings,
  `checkStreamEdit` in lib/tasks/stream.ts, 200-character hint),
  `add_trip_checklist` and `sync_trip_hotel_step` (the trip screen's two
  buttons, moved into lib/trips/write.ts `addTripChecklist` and
  `syncTripHotelStep`; the B16 no-duplicate rule is seedTripChecklist's),
  `update_trip_leg` and `remove_trip_leg` (lib/trips/legs.ts; leg_index is
  the position in lifeos_list_trips, which now prints it, counted from 0; undo
  writes back the raw jsonb exactly as it was read). Removing a leg edits the
  trip. There is still NO delete tool for a trip, an expense or a project.
- Extended: create_task and update_task take `project_id` (checked against
  his projects, lib/tasks/tool-fields.ts `resolveTaskExtras`) and
  `recurring_rule`; update_task also `billable`. The update snapshot is
  `TASK_UNDO_COLUMNS` and the restore `taskUndoPatch`, both in tool-fields.ts.
  update_trip takes `cities`, and its undo now also restores cities, the hotel
  arrangement and the session fields its snapshot always carried.
  lifeos_list_tasks returns billable, project, lapses_on, recurring_rule,
  reminder_mode, created_at and completed_at, and its search matches the note
  too. get_context prints the stream and created date on every task row,
  scanned-email rows included, still inside the fence (lib/assistant/
  context-tasks.ts); the 30-row cap stays on the query.
- New read tools (mcp-api.ts): `lifeos_get_month_pack` (monthPackFromRows in
  lib/trips/month.ts, the same mapping the Month pack screen uses; still no
  invoice, no total), `lifeos_list_trip_expenses`, `lifeos_get_last_brief`,
  `lifeos_list_scan_runs` (lib/assistant/scan-runs.ts, counts and ids only
  from the cron_scan, 3 AM mail_scan and tasks_lapsed audit rows, never
  notes, rejection reasons or mail text), `lifeos_list_work_streams`,
  `lifeos_search` (lib/assistant/search.ts: tasks, notes, people, trips, every
  word must appear, 25 results, 120-character excerpt, email-sourced excerpts
  fenced), `lifeos_report_lapsed_tasks` and `lifeos_report_premature_tasks`
  (the two scripts' logic moved to lib/tasks/reports.ts; the scripts
  re-export it), and `lifeos_read_mail_attachment`. The m4 naming rule for
  read tools now also accepts `lifeos_search` and `lifeos_report_`.
- (Removed in B24, with the chat.) The in-app chat was offered the B22 reads (`IN_APP_READ_TOOLS`,
  `inAppReadTools` in mcp-api.ts; tools.ts `LlmTool` is what a model is shown
  of a tool). The chat route sends those names to runReadTool with its own
  cookie actor, so RLS applies, and everything else to executeToolCall as
  before. They are not registry tools, have no bucket and change nothing.
- The brief store: the cron keeps the composed text (`keepBrief`,
  lib/brief/store.ts and store-db.ts) in `briefs`, one row per IST day, and
  deletes rows older than 30 days in the same run. A table, not an audit row:
  audit_log is append-only and cannot be trimmed, and the brief carries task
  titles, some from scanned mail. RLS owner-only, anon revoked; the cron and
  the connectors reach it as service_role and scope by user_id. A failure to
  keep it never stops the send.
- Attachment text, on request only (lib/assistant/attachment.ts): ONE named
  PDF or Word .docx attachment of a thread in taxstrategia, ca_tapasnr or
  altechon (checkMailSlot refuses icai), 5 MB at most (refused before
  download on the provider's size and again on the real length), 20,000
  characters at most, fenced as untrusted. PDF through the B20 unpdf reader
  (`pdfText` now takes a cap). DOCX through lib/assistant/docx-text.ts: the
  zip central directory read by hand and `word/document.xml` inflated with
  Node's built-in zlib, no new dependency, output capped against zip bombs.
  The audit row (`mail_attachment_read`) is written before the text is handed
  over and carries account, thread_id and attachment_name only; if it cannot
  be written nothing is handed over. It rides the existing mail_body class
  (the union still has five members). The nightly scan is unchanged and never
  reaches this module; scripts/b22.test.ts fails if scan.ts names it.
- Approved the same day: ICAI mail asking a branch to coordinate faculty or
  travel arrangements for an AICA batch is never a task.
  `matchesNeverExtract` returns `BRANCH_COORDINATION` when "coordinat",
  "faculty" or "travel", and "batch" all appear, and SCAN_SYSTEM says so.
- Tests: `npm run test:b22` (28 offline, synthetic data, a real unpdf
  extraction and a real hand-built .docx).
- B27 (no migration): long attachments and tracked changes. `offset` (whole
  number, default 0) lets an agent read a long file in parts: each call still
  returns at most 20,000 characters, plus `offset`, `total_chars`,
  `next_offset` (null at the end), and `has_tracked_changes`. One file is read
  for 400,000 characters at most whatever the offset; `beyond_read_limit` says
  when there was more. An offset past the end is refused. The audit row
  (`mail_attachment_read`) now also records the offset, never text.
  lib/assistant/docx-text.ts `docxRead` keeps what `docxText` dropped: an
  insertion reads `[inserted by <author>: ...]`, a deletion (`w:delText`)
  `[deleted by <author>: ...]` (moves count as insert and delete), the author
  is left out when the file has none, a comment anchor reads `[comment <id>]`,
  and the comments of `word/comments.xml` follow the body under "Comments:" as
  `[comment by <author>: ...]`. `has_tracked_changes` is true when the file
  holds any insertion, deletion or move, comments alone do not count. Still no
  new dependency: the same hand-read zip and Node zlib.

## Scan alarm, catch-up and no in-app chat (B24)

No migration. Decided 29 September 2026 after the 3 AM scan failed every night
from 21 September (the AI key was refused, 401) and nobody noticed for 8 days.

- THE AI KEY IS FOR THE NIGHTLY SCAN ONLY (task triage, ticket PDFs, cab
  receipts). Thinking and chatting happen in Claude (phone app, Superman
  routines) through the connector. The in-app chat is gone: the chat route,
  chat.tsx, chat-store.ts, chat-history.ts, the chat server actions, the
  Settings chat model choice, the health route's chat role and the
  /assistant?ask=priorities link. `/assistant` opens on the Queue (History and
  Audit stay). `scanMailAction`, `runLlmTurn`, wire.ts, config.ts and the tool
  registry stay. Left in the database, unread, removable in a later migration:
  `assistant_settings.chat_provider`, `assistant_settings.chat_model` and the
  `assistant_chat_turns` table (owner-only, service_role revoked). Also
  removable later: `buildAppContext` and `buildSystemBlocks` no longer feed
  any chat prompt (the house-rules tool and tests still use parts of them).
- Scan health line: `scanHealthWarning` (lib/brief/scan-health.ts, pure) reads
  the last 36 hours of `cron_scan_started`, `cron_scan` and `cron_scan_failed`
  audit rows for today's IST date. No finish row: "Mail scan did not run last
  night" (or "was cut off before finishing" when a start row exists). Failed:
  "Mail scan failed last night: the AI key was refused. Check the key in
  Vercel." (reason_code auth). A start after the last finish counts as cut
  off; a good manual re-run after a failure clears it. It is the first line of
  the brief (HTML, text and the stored B22 copy) and nothing is printed when
  healthy. `lifeos_list_scan_runs` shows `started_never_finished`.
- Failure handling: every model pass goes through `modelTurn` in scan.ts. The
  first auth or provider error becomes a `ScanModelError` (code auth or
  provider, a fixed short phrase such as "AI key refused (401)", never the
  provider's body) and, since nothing catches it, no later pass or account is
  tried. The cron records `cron_scan_failed` with `reason_code`. The
  already-ran guard reads `cron_scan` rows only, so a failed or started-only
  run never blocks a same-day manual re-run.
- The scan route writes `cron_scan_started` first and has `maxDuration = 300`
  (was 60; a Vercel timeout leaves no row, so the start row is how "cut off"
  is told from "never ran").
- Catch-up: `scan_mail` takes optional `days` (whole number, 1 to 14, default
  3) and `account` (a slot name). Parsed by `parseScanArgs` in
  lib/assistant/scan-args.ts, which also holds the limits: above 3 days the
  message cap is days x 15 (at most 150) and the per-account task cap is
  5 x days, for that run only. The cron passes nothing (3 days, 15 messages,
  5 tasks, all accounts). Every dedupe rule is unchanged. Run it once per
  mailbox from a fresh Claude chat so each call stays under the connector's 60
  second limit.
- A mail whose `lapses_on` is before today creates no task (`windowAlreadyClosed`,
  checked in taskPass).
- Tests: `npm run test:b24` (18 offline). It runs the real scan and the real
  cron route against in-memory stand-ins (scripts/b24-loader.mjs maps the "@/"
  alias and swaps the network modules for scripts/b24-stubs.ts).

## Instructions for agents on each task (B26)

Migration `20260929000100_b26_task_agent_instructions.sql`. NOT applied anywhere
when it was written; apply it before (or with) the deploy of this code, since
the Tasks page, Home and both connectors select its columns. Nullable
additions only, nothing backfilled, RLS unchanged.

- The goal (Agents MASTER_PLAN step 13): Tapas gives his AI workforce an
  instruction on the task itself, in Life OS, instead of replying in Slack
  threads. The daytime sweeps read the pending instructions through the
  connector, work inside their guardrails and write a result and a status back.
  Slack `#tasks` stays as the phone alert.
- Columns on `tasks`: `agent_instructions` (at most 2,000 characters, check
  constraint), `agent_instructions_at`, `agent_status` (`done` or `needs_you`,
  null means no result yet), `agent_result` (at most 4,000),
  `agent_result_at`, `agent_done_hash` (sha256 of the instruction text the last
  result answered). Column comments in the migration say who writes each.
- THE GUARD, and the reason for it: an instruction is an ORDER to an agent, so
  only Tapas may write one. The mail scan writes tasks from untrusted email and
  the connector is reachable by outside models; if either could write an
  instruction, an email could plant orders. It is enforced by the database,
  not by leaving a parameter out of a tool schema, because the connectors reach
  the database as `service_role`, which bypasses RLS. The trigger
  `guard_task_agent_instructions` (before insert or update on tasks) raises
  unless the caller is the OWNER SESSION: `auth.role() = 'authenticated'` and
  `auth.jwt() ->> 'role' = 'authenticated'` and `auth.uid() = new.user_id`. It
  refuses (a) an INSERT carrying a non-null instruction or stamp and (b) an
  UPDATE that changes the instruction or its stamp. "Changed" is `is distinct
  from` on the trimmed text with blank as null, so an ordinary drawer save that
  resends the same text changes nothing (the trigger even restores the stored
  text and stamp). For the owner it stamps `agent_instructions_at = now()` and
  clears `agent_status` when the instruction truly changes; `agent_result`
  stays visible until replaced. The owner's saves run through `requireUser`
  (cookie client); the connectors, crons and scan run as `service_role`; MCP
  OAuth tokens are app-issued, never Supabase JWTs; a direct database session
  has no JWT, so it is refused too. Why not a column-level `revoke`: Postgres
  keeps the table-level UPDATE grant beside column grants, and that grant still
  allows every column, so revoking one column changes nothing (revoking the
  table grant would break every other task write from the connectors).
- Belt above the belt: `createTask` and `updateTask` (lib/tasks/write.ts) read
  `agent_instructions` only when the origin is `"app"` (his own drawer, through
  `updateTaskAction`). Every other origin drops it. No tool schema declares it,
  including the scan's `propose_task`; scripts/b26.test.ts walks every schema.
- Pending is DERIVED, never stored: `isPendingInstruction`
  (lib/tasks/agent-instructions.ts): non-blank instruction, task not done or
  dropped, and `sha256(instruction)` (the existing `hashPayload`) differs from
  `agent_done_hash`. The server always computes the hash; agents only echo it.
  The Tasks page computes it server-side and hands the browser a boolean
  (`agent_pending`), because hashing needs node:crypto. The display rules are
  in the import-free lib/tasks/agent-display.ts.
- What Tapas sees: the task drawer has "Instructions for agents" (2,000
  characters, counter; blank saves as null) and below it, read-only, the status
  in plain words ("Waiting for the next sweep", "Done 29 Sept, 12:40 pm",
  "Needs you"), the result and when it was written. The shared `TaskRow`
  (Board, Inbox, Projects) carries one badge: "Agent" while pending, "Needs
  you" when the agents asked for him. Home shows "2 agent results need you",
  linking to `/tasks?agent=needs_you` (the Tasks page then lists only those);
  nothing when zero.
- Two connector tools, both on `/api/mcp` and `/api/mcp/http`, disclosure
  `app_data`, no new class:
  - `lifeos_list_agent_instructions` (read, no parameters): pending
    instructions, oldest first, at most 10: task id, title, stream, project,
    note, due date, task status, `instruction` (labelled as written by Tapas in
    the app), `instruction_hash`, `instruction_at`. The title and note keep the
    `untrusted` flag for `source=email` rows. Every call writes an audit row
    (`agent_instructions_read`: count and task ids only) BEFORE anything is
    handed over, and the insert is checked (the B15 pattern).
  - `report_agent_result(task_id, instruction_hash, status, result)`
    (autonomous, `TOOL_TARGETS` entry on tasks): `status` done or needs_you,
    `result` plain text at most 4,000 characters. Refused when the hash is not
    the CURRENT instruction's; the refusal returns the current instruction and
    hash so the sweep needs no second call. A task done or dropped meanwhile is
    still accepted. It writes the four result columns with a compare-and-swap on
    the instruction text. Undo restores the previous result columns (hash
    included), which RE-OPENS the instruction: the next sweep does it again.
    Registered as undoable in execute.ts and in the History tab.
  - The tool descriptions say an instruction grants an agent no tool it does
    not already have. Nothing here sends, pays or deletes.
- No instruction or result text in `audit_log` meta, logs or the
  `assistant_actions` payload: ids, the hash, status and lengths only (the row
  keeps `result_chars`; the words live on the task).
- Paths that copy task rows: the `delete_task` undo snapshot is read with
  `select("*")` and re-inserted as service_role, so the re-insert strips
  `agent_instructions` and `agent_instructions_at` (or the guard would refuse it
  and the task would be lost); `delete_task` also refuses a task with a pending
  instruction. `TASK_UNDO_COLUMNS` and `taskUndoPatch` never include either
  column. The recurring spawn's fixed column list names no agent column, so a
  next occurrence starts with no instruction, result or status.
- What agents may and may not write: they may write `agent_status`,
  `agent_result`, `agent_result_at` and `agent_done_hash`, only through
  `report_agent_result`. They may never write `agent_instructions` or
  `agent_instructions_at`, through any tool, parameter or copy path.
- Deferred, not built: a claim step, a "Clear result" button, a 7 AM brief
  line, agent status in `lifeos_list_tasks` and `get_context`.
- Tests: `npm run test:b26` (24 offline; the real executor and read tool run
  against an in-memory database, scripts/b26-loader.mjs and b26-stubs.ts). The
  live proof of the trigger is the last test in scripts/rls.test.mjs, for the
  local stack (`supabase start`, migration applied, `npm run test:rls`); never
  run `test:rls:cloud` for it.
- B27 (no migration): every task read now says where its email is. For a task
  with `source='email'`, `lifeos_list_agent_instructions` and
  `lifeos_list_tasks` return `mail_account` (the slot from `external_ref`) and
  `mail_thread_id` (`external_thread`); an agent passes both to
  `lifeos_read_mail_thread`, or passes the task's `external_ref` as
  `message_ref`. A row with no stored `external_thread` (older than B20) is
  looked up once through the mailbox (`taskMailFields` in
  lib/assistant/task-mail.ts) and the answer written back to
  `tasks.external_thread` only while that column is empty, so it is resolved
  once. That column is not an agent column, so the B26 guard is not involved.
  At most 10 lookups per call; a provider failure leaves `mail_thread_id` null
  and never fails the list. The icai slot is never resolved and shows null
  fields. Not done: the same fields in the `get_context` task rows (that text is
  built without a mailbox call, and resolving there was not cheap).
- Tests: `npm run test:b27` (15 offline; the real read tools run against the
  b26 in-memory database and a mocked mailbox, scripts/b27-loader.mjs and
  b27-stubs.ts).

## Journeys, and client (non-ICAI) training trips (B28)

Two migrations, NOT applied anywhere when they were written; apply both, in
order, before (or with) the deploy of this code, since the trips screens and
both connectors select `journey_id`:
`20261001000100_b28_enum_values.sql` (enum values only) and
`20261001000200_b28_journeys.sql` (the column, its index and the home city
clean). They are two files because Postgres refuses to use an enum value in
the transaction that adds it; a test fails if the first ever uses one.

- The problem, in his words on 1 October 2026: he also trains for Cygnet (its
  clients), and one continuous journey serves several engagements, for example
  Ahmedabad, Bengaluru (Cygnet, 7 Oct), Delhi (Cygnet, 8 Oct), Surat (ICAI,
  9 Oct), home. Cygnet pays flights and hotels; he books cabs and Cygnet
  reimburses them. He wants the journey's expenses together, each marked to
  the engagement it belongs to.
- Design: each engagement stays its own `trips` row (a "session" on screen);
  sessions of one journey share `trips.journey_id` (uuid, nullable, indexed,
  NO table and NO foreign key: a journey's title, cities and dates are derived
  from its sessions, lib/trips/journey.ts). Every per-trip rule (month pack,
  checklist, hotel step, cab and ticket matching, calendar entry) is
  unchanged. A journey_id carried by one trip alone (the other was deleted, or
  a join was undone) is just a trip: the list shows it as it always did.
- New enum values: `trip_purpose` training ("Training (non-ICAI)"),
  `trip_bills_to` client ("Reimbursed by the client", the client being the
  session's WORK STREAM, no new client field), `hotel_arrangement` client
  ("Client arranges"). Labels live in lib/trips/core.ts (purpose, moved from
  components/trips/bits.tsx so a test can walk them), month.ts (bills_to) and
  checklist.ts (hotel). A test walks every value of every enum in
  lib/database.types.ts and fails on a missing label.
- Defaults, in `createTrip` (one place, form and connector alike): a training
  with no bills_to is `none` (travel built into his fee; `client` stays
  selectable), and with no hotel arrangement defaults to `client` when the
  stream is Cygnet, else `self` (a day return is still `same_day`).
- The client hotel arrangement MEANS "the client books travel and hotel". The
  checklist therefore drops the book-ticket and hotel steps and has exactly
  three: "Confirm flights booked by <stream>" (7 days before the start),
  "Confirm hotel booked by <stream>" (5 days before), "Collect cab receipts"
  (the end date). `ChecklistTrip.stream_name` carries the client; write.ts
  reads it from the work stream. `isHotelStepTitle` (checklist.ts) is what the
  M6c hotel-step sync and the trip screen use, so the client wording counts as
  app-written. Switching an existing trip TO client does not retire its old
  "Book onward ticket" steps: the sync only handles the hotel step and the
  onward note, as before.
- Home city never a trip city: `stripHomeCity` (core.ts, one constant
  HOME_CITY_PREFIXES, case-insensitive prefix match on "ahmedabad" and
  "sabarmati") runs in createTrip, updateTrip (so also the connector and
  undo) and the checklist; the migration cleans existing rows once. LEGS are
  never touched.
- Which session a date belongs to: `tripForDate` (lib/trips/ticket.ts) is the
  one place. Among the trips holding the date (else within the slack): (1)
  when given `places`, prefer a trip whose city (home excluded) appears in
  them, case-insensitive; (2) else the trip whose `session_date` (its end date
  when it has none) is nearest the date; (3) a tie goes to the later trip, the
  one he is travelling to. Order-independent. B21 cab rides pass the RAW
  from and to areas (so "Hotel, Delhi" still says Delhi; only the cleaned area
  is stored), and a ride from home matches no session city, so it falls to
  the date rule and lands on the first session. B20 ticket legs pass the leg's
  destination. The scan's two trip queries now order by start date then id.
  Note what the date rule alone gives on the example journey: 7 Oct is
  Bengaluru's session day (Bengaluru), 8 Oct is Delhi's (Delhi); it is the
  city rule that sends the Surat airport ride of 8 Oct to Surat.
- Moving an expense between sessions: `trip_id` is part of the expense edit
  patch (expense-edit.ts, `updateTripExpense`, the `update_trip_expense` tool).
  The target must be one of his trips, else the write is refused and the
  expense stays. Whole, never split. Undo restores the old trip.
- Month pack per claim: `buildMonthPack(trips, expenses, month, claim)` and
  `monthPackFromRows`; `claim` is "icai" (default, today's behaviour on
  `icai_monthly`) or a work stream name, which lists that stream's sessions
  with bills_to client, its reimbursable (billable) expenses with receipt
  status and the gaps, headed "<Stream> reimbursables". In the ICAI view a
  client session is excluded as "Reimbursed by <stream>", not "Not billable to
  anyone". Same records-only text, no totals, no invoice shape (M6d stands).
  /trips/month shows a claim chooser when a client session exists; Copy copies
  the view shown. `lifeos_get_month_pack` takes `claim` (one string).
- Screens: the trips list folds sessions sharing a journey_id into one card
  (cities in travel order, dates, each session with type, stream and session
  date) linking to `/trips/journey/<journey_id>`: every session, every leg in
  date order, every expense of every session with a "For" dropdown (moves the
  expense) and "+ Expense" asking "For which session?" with the nearest by
  date preselected. The trip form has "Part of the same journey as..." (his
  upcoming trips) and "Remove from journey". The trip screen links to its
  journey.
- Connector: `create_trip` and `update_trip` take `same_journey_as` (the id of
  a trip already on the journey: the server finds that trip's journey_id, or
  mints one and writes it onto both) and `journey_id` (an id one of his trips
  carries, or "none" to leave); `lifeos_list_trips` returns `journey_id`
  and its purpose filter takes training. Undo of update_trip restores
  journey_id. Undo of a join that minted an id leaves that id on the other
  trip, harmless (one trip alone is not a journey). Parameter census now 202,
  131 optional, still zero unions.
- Deferred, not built: a `journeys` table and journey tools, de-duplicating
  trip calendar events against existing Cygnet events (a session adds one
  harmless all-day entry), split expenses.
- Tests: `npm run test:b28` (38 offline; the real executor and the real
  lib/trips/write.ts run against the b26 in-memory database,
  scripts/b28-loader.mjs and b28-stubs.ts). m6, m6c and b22 were updated for
  the new enum values (4 hotel arrangements became 5).

## Family travel calendar (B29)

Migration `20261002000100_b29_family_travel.sql`. NOT applied anywhere when it
was written; apply it before (or with) the deploy of this code, since Settings
selects `calendars.is_family_travel` and every trip write calls the sync.
Additive only.

- The problem, in his words on 1 October 2026: his spouse keeps asking for his
  travel plans, Life OS holds them, and she uses Google Calendar. Decision: a
  SEPARATE Google calendar that Life OS keeps up to date and that he shares
  with her, read-only. A private public web link was considered and rejected:
  a leaked link would tell anyone when his home is empty, and it adds a public
  surface to the app. A calendar shared to her account needs no new public
  route.
- THE PRIVACY RULE (his words, and the most important line of this section):
  she sees the city, the session days, and each leg's mode, time and route.
  Nothing else: no PNRs or booking references, no hotel details, no client or
  organisation names (not ICAI, not Cygnet, not the trip title, notes, work
  stream, purpose or session label), no amounts.
- How it is enforced, in `lib/family/travel.ts` (pure): the event builders read
  ONLY a session date, the first city (home stripped) and each leg's from, to,
  date, mode and time, so a title, note, stream, label, PNR or cost is never in
  reach. Each event is a summary, a start and an end, and nothing else: no
  description, location, attendees or visibility, `reminders` is
  `useDefault: false` with no overrides, and all-day events are transparent.
  Place names are free text, so `safePlace` makes each one safe by construction:
  a place containing a forbidden word (icai, aica, cygnet, hotel, inn, resort,
  residency, suites, marriott, taj, itc, novotel, hyatt, lemon tree, ginger,
  fortune, radisson, oyo, office, bhavan, institute, chapter, branch, client,
  guest house) or any work stream name (loaded from work_streams on every run),
  or a digit, or more than three words, is WITHHELD; everything after a comma or
  an opening square or curly bracket is cut; a round bracket survives only as
  one or two plain words ("Ahmedabad (Ambli Road)"). A withheld leg place falls
  back to travel wording ("Flight to Surat", or just "Flight"); a withheld
  session city writes no session event. scripts/b29.test.ts has a test for each
  class and fails if travel.ts ever reads one of the private fields.
- What is written (trips and legs from 30 days before today to 120 days after
  it, so a leg does not vanish the morning after it mid-trip; cancelled trips
  excluded): for each session date an all-day "In <city> (full day)"; for
  each leg a timed "<Mode> <from> to <to>" at its time, 60 minutes long (flight
  120), or with no time an all-day "<Mode> <from> to <to> (time to be
  confirmed)". Mode words: Flight, Train (Vande Bharat, Tejas, AC sleeper), Cab,
  Travel (other). Place names pass through as written.
- Leg time: legs (jsonb) gain an optional `time`, "HH:MM" IST 24-hour, no
  migration. `checkLegTime` (lib/trips/core.ts) is the one validator: log_trip_leg,
  update_trip_leg and the B20 ticket proposal (propose_trip_leg) all use it, a
  bad value is refused on the two tools and, on the ticket proposal, left empty
  while the leg is still recorded. The ticket pass fills it only when the ticket
  states it clearly. parseLegs drops a malformed value on read. The trip screen
  and journey page show it and the leg form edits it. lifeos_list_trips returns
  `time` (null when unknown). Undo covers it (the legs are restored whole).
- Which calendar: `calendars.is_family_travel` (nullable boolean, partial unique
  index, one per user). Chosen only by the owner-session Settings action
  `setFamilyTravelCalendarAction` ("Family travel calendar" beside the
  reminder-home choice); no tool or connector names it, and b29.test.ts fails if
  one does. A trigger insists on the ca_tapasnr account and refuses the
  reminder-home calendar. Calendar sync lists every calendar on the account
  (`calendarList`, secondary calendars included), so a calendar he creates and
  shares appears after Refresh calendars. The ca.tapasnr reminder-home and
  write-back calendars cannot be chosen (UI, Settings action and trigger), and
  setReminderHomeAction refuses a family calendar BEFORE it clears the current
  home. "None" removes every event Life OS wrote there; switching calendar
  clears the old one first and the flag does not move if that clear did not run.
- The sync: `family_travel_events` (user_id, trip_id, kind, item_key,
  ext_event_id, ext_calendar_id, content_hash; RLS owner only) records what Life
  OS wrote, and every patch and delete goes to the recorded `ext_calendar_id`
  (an event recorded on another calendar is removed there and made on the
  current one). Every read the sync depends on (trips, work streams, recorded
  events, calendars, account) is checked: a failed read stops the run before any
  Google call and returns ran:false, because an error read as an empty list
  would delete every event or create them all twice. Only clearFamilyTravel
  passes an explicit empty desired set.
  `syncFamilyTravel(owner)` (lib/family/sync.ts) creates, updates (content hash
  changed) or deletes ONLY recorded events. An event on that calendar that Life
  OS did not write is not in the table, so nothing can name it. trip_id is
  `on delete set null`, so a deleted trip's events keep their Google ids and the
  next sync removes them. It runs after createTrip, updateTrip (when legs,
  status, cities or session date are in the patch) and deleteTrip in
  lib/trips/write.ts, which every browser, assistant and connector write uses
  (so leg log, update, remove, undo and cancel are all covered), and once a day
  from the 7 AM brief cron as a repair pass. It never throws and never blocks the
  trip write; a failure is an audit row (`family_travel_sync_failed`) with counts
  and a short reason, never event text. Google calls are the reminder writer's
  own (`gcalCreate`, `gcalPatch`, `gcalDelete`, now exported), so each is inside
  withResourceAuth. A patch names the unused start field as null and states
  transparency, so an all-day leg that gains a time converts in place.
- A leg's `item_key` is its date, route and an occurrence number among identical
  ones, NOT its position in the list, so removing one leg deletes only its own
  event instead of shifting every later key.
- Not built: a lock against two syncs in the same second (one user; the
  duplicate would show and the next repair pass would not remove it, add a row
  lock if it ever does), de-duplicating against events already on the family
  calendar by hand, and hiding the family calendar from his own synced calendar
  view.
- Tests: `npm run test:b29` (offline, two files; the calendar is an in-memory
  stand-in, the tools run through the real executor and the real
  lib/trips/write.ts against the b26 in-memory database via
  scripts/b28-loader.mjs, and scripts/b29-sync.test.ts runs the real sync.ts
  against a database stand-in that can fail a read, via
  scripts/b29-sync-loader.mjs).

## Unbilled work (B30)

Migration `20261002000200_b30_unbilled_work.sql`. NOT applied anywhere when it
was written; apply it before (or with) the deploy of this code, since Settings,
the Tasks page, /unbilled, the Monday brief and both connectors select its
columns. Defaulted or nullable additions only, nothing backfilled, no stream
seeded as billable, RLS unchanged.

- The problem, in his words on 1 October 2026: work he has already done is
  never invoiced. Tasks get marked done and the billing is forgotten. M6d
  still holds: Life OS never produces an invoice, a number, a total or a PDF
  and never calls Zoho. B30 only records which work is billable and where its
  billing stands. No amounts anywhere; scripts/b30.test.ts fails if a B30 file
  grows one.
- Columns: `work_streams.billable` (boolean, not null, default false; he ticks
  it in Settings > Work streams, "Billable: finished tasks show on Unbilled
  until invoiced"). `tasks.billable` (nullable: null follows the stream, true
  or false overrides it). `tasks.billing_state` (null, `estimate_drafted`,
  `invoiced`, `not_billable`; check constraint), `tasks.billing_ref` (at most
  40 characters, the Zoho estimate or invoice number) and
  `tasks.billing_updated_at` (stamped by the trigger). Note the older
  `tasks.is_billable` (M1, not null default false, written by the
  `billable` parameter of create_task and update_task) stays in the schema but
  no longer feeds the unbilled list or the drawer; only `tasks.billable` and the
  stream's tick count. `work_streams.feeds_billing`
  (M6d, which streams feed his invoice run) is a different flag and its label in
  Settings now reads "in the invoice run".
- Effective billable, pure in lib/billing/unbilled.ts `effectiveBillable`:
  recurring tasks (`recurring_rule`) and trip checklist steps (`trip_id`) are
  NEVER billable work, whatever the flags say (trips bill through the month
  pack); otherwise the task's own `billable` wins, else the stream's tick
  (`task.billable ?? stream.billable`, nothing else).
- The list, `unbilledGroups` (same file): done tasks, effectively billable,
  completed in the last 180 days, `billing_state` null or `estimate_drafted`,
  grouped by work stream, oldest completion first (rows and groups). A row is
  title, project, completion date, days since, and the estimate ref if one was
  drafted. `lib/billing/load.ts` `loadUnbilled` is the one query, used by
  /unbilled (cookie client), the Monday brief and the connector, so they cannot
  disagree.
- `/unbilled` (nav item "Unbilled", the nav is now nine items): grouped list,
  each row with "Invoiced" (asks for the optional reference first, so a stray
  tap does not fire) and "Not billable". The last change shows an Undo bar.
  The task drawer has the three-way "Follow stream, Billable, Not billable" and,
  for a done task, a Billing box (Invoiced with a reference, Not billable this
  time, Reopen, Undo). His own marks go through lib/billing/write.ts
  `setBillingState` (server actions in app/(app)/unbilled/actions.ts) and each
  writes an `audit_log` row (`billing_state_set`) with the previous state and
  reference; Undo writes those back.
- Monday nudge: `composeBrief` takes `unbilled` (a summary) and, on a Monday
  only and only when there is some, prints one line "Unbilled work: <n>
  finished tasks across <stream names> not invoiced, oldest from <date>." with
  a link to /unbilled, in the HTML, the text and so the stored copy. Stream
  names only: no client detail. The brief cron reads it on Mondays only and a
  failed read never stops the brief. No new cron.
- Connector: `lifeos_list_unbilled` (read, optional `work_stream`, disclosure
  `app_data`) returns the same rows with task ids and each task's
  `instructions_for_agents` (his B26 words) if set. `lifeos_set_billing_state`
  (registry `set_billing_state`, autonomous, undoable, TOOL_TARGETS on tasks):
  `task_id`, `state` (`estimate_drafted` or `not_billable`, one string type),
  optional `ref` (at most 40 characters). `lifeos_list_tasks` now returns
  `billable` (effective), `billing_state` and `billing_ref`.
- THE GUARD, the reason for it, and how it works: only Tapas's own session may
  mark work invoiced, otherwise an agent could hide unbilled work. The
  connector can never set `invoiced`, never clear a state and never move a task
  that is marked invoiced. Enforced three times: the tool schema has no
  `invoiced` value; `checkAgentBilling` and the performer refuse it on the
  server, and an undo over the connector is held to the same rule
  (`undoAllowedForService`, checked before the undo claims the action, so a
  refusal leaves it undoable from the app); and the trigger
  `guard_task_billing_state` (before insert or update on tasks, same caller test
  as B26: authenticated role, JWT role and uid equal to the row's owner) refuses
  a non-owner who sets `invoiced`, clears a state, or changes billing_state or
  billing_ref on a row that is `invoiced`. It stamps `billing_updated_at`
  whenever state or reference change. `delete_task` refuses a task marked
  invoiced (its undo re-insert runs as service_role and could not restore it).
- Not built, and a known residue: no tool writes `tasks.billable`, so an agent
  cannot mark work not billable that way, but the existing `update_task` can
  still move a task out of `done` or drop it, which takes it off the list (that
  was true of every task field before B30). The Monday line and the page do not
  list a task that is not done.
- Tests: `npm run test:b30` (offline; the real executor, the real connector
  reads and the real brief composer, run against the b26 in-memory database).
  The live proof of the trigger belongs in scripts/rls.test.mjs on the local
  stack; it was not run for this build (no database), and test:rls:cloud is
  never run for it.
