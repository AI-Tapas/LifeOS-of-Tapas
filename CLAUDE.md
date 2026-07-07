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
