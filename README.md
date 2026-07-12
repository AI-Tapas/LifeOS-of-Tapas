# Life OS

Single-user PWA: executive assistant and work-life second brain. Milestone 1:
repo, database, auth, seeds, installable PWA shell.

## Local setup

Prerequisites: Node 20+, Docker Desktop, Supabase CLI.

```
npm install
supabase start
```

`supabase start` applies all migrations and prints the local keys. Copy the
env template and fill it from that output (or `supabase status`):

```
cp .env.example .env.local
# NEXT_PUBLIC_SUPABASE_URL      = API URL   (http://127.0.0.1:54321)
# NEXT_PUBLIC_SUPABASE_ANON_KEY = anon key
```

Then:

```
npm run dev
```

Open http://localhost:3000 (use localhost, not 127.0.0.1, if you want
passkeys to work). Sign in with tapas.tnr@gmail.com; the email with the code
and magic link appears in the local mail viewer (Mailpit, URL shown by
`supabase status`). First sign-in seeds the work streams, visible under
Settings.

## Scripts

- `npm run dev` - dev server
- `npm run build` - production build
- `npm run test:rls` - RLS and allow-list proof against the local stack
- `npm run test:rls:cloud` - the same proof against the cloud project; reads
  `.env.local` via `--env-file` and needs the non-prefixed `SUPABASE_URL` /
  `SUPABASE_ANON_KEY` aliases set there (see `.env.example`)
- `npm run test:oauth` - pure-logic proof of the OAuth token layer (PKCE, token
  parse, refresh, revocation); no stack needed, requires Node 22.18+
- `npm run db:types` - regenerate lib/database.types.ts from the local schema
- `npm run icons` - regenerate placeholder PWA icons

## Fresh database

```
supabase db reset
```

Reapplies every migration. Seed data arrives on first sign-in (trigger), so
sign in again afterwards.

## PWA

Installable on Android Chrome (menu, Add to Home screen). The service worker
(public/sw.js) caches the app shell and last-loaded pages for offline
reading. No offline writes in V1. Note: service workers require HTTPS or
localhost, so test installs against localhost or the deployed URL.

## Accounts and OAuth (Milestone 2)

The app connects external accounts (two Google, one Microsoft 365, one
restricted Google Workspace) as app-level OAuth integrations, separate from the
Supabase sign-in. Refresh and access tokens are stored encrypted in Supabase
Vault; the accounts row keeps only the secret ids, and decryption happens
server-side only via service-role functions (`set_account_tokens`,
`get_account_tokens`, `clear_account_tokens`). No token reaches the browser.

Slots (Settings > Accounts):

| Slot | Provider | Client | Scopes |
|---|---|---|---|
| taxstrategia | google | Internal (Client A, Trusted) | calendar, gmail.readonly, gmail.send |
| ca_tapasnr | google | External (Client B, unverified) | calendar, gmail.readonly, gmail.send |
| altechon | microsoft | single-tenant Entra app | Calendars.ReadWrite, Mail.Read, Mail.Send, offline_access, User.Read |
| icai | google | External (Client B) | calendar.readonly, gmail.readonly |

Two Google clients are mandatory: an Internal-audience client cannot serve
accounts outside its org, so Client A serves taxstrategia and Client B serves
the consumer and icai.org accounts.

### Environment

Set in `.env.local` (local) and Vercel (production). See `.env.example`:

- `SUPABASE_SERVICE_ROLE_KEY` (server-side only, NOT `NEXT_PUBLIC_`)
- `APP_BASE_URL` (must match the registered redirect URIs exactly)
- `GOOGLE_INTERNAL_CLIENT_ID` / `GOOGLE_INTERNAL_CLIENT_SECRET`
- `GOOGLE_EXTERNAL_CLIENT_ID` / `GOOGLE_EXTERNAL_CLIENT_SECRET`
- `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_TENANT_ID`

### Redirect URIs to register (by hand, in the consoles)

One redirect URI per provider; both Google clients register the same Google
string. Replace `YOUR-DOMAIN` with the Vercel domain.

Google (register on BOTH Client A and Client B, Authorized redirect URIs):

```
http://localhost:3000/api/oauth/google/callback
https://YOUR-DOMAIN/api/oauth/google/callback
```

Microsoft (Entra app registration, Web platform, Redirect URIs):

```
http://localhost:3000/api/oauth/microsoft/callback
https://YOUR-DOMAIN/api/oauth/microsoft/callback
```

Use `localhost`, not `127.0.0.1` (Google's localhost exception, and it must
match `APP_BASE_URL`).

### Manual console steps

1. Create the three OAuth clients (two Google, one Entra) and fill the env vars.
2. Mark Client A's client ID **Trusted** in the Workspace Admin console.
3. Client B: set publishing status to **Production** (leave it unverified). On
   the first ca.tapasnr connect, click through the unverified-app warning once.
4. Entra app: grant **admin consent** for the delegated permissions.
5. Connect each slot from Settings > Accounts. For icai.org, attempt the direct
   connect; if the org admin blocks it (expected), use the **Treat as
   forwarded** toggle on that card. Mail then arrives via the Gmail forwarding
   filter into ca.tapasnr (arranged outside the app).

Vault is enabled automatically by the M2 migration (the `supabase_vault`
extension); no dashboard step is required.

### Re-auth lifecycle

When a refresh token is revoked (the expected case is a ca.tapasnr password
change; the provider returns `invalid_grant`), `get_valid_access_token` flips
the account to `needs_reauth`, writes an `audit_log` row, and the app shell and
Settings show an amber banner with a one-tap **Reconnect** that reruns the
consent flow. Microsoft rolls its refresh token on every refresh; the newest is
always persisted.

### Verifying token refresh and revocation

`npm run test:oauth` proves the pure token logic (PKCE, parse, refresh success
for Google and Microsoft, `invalid_grant` to revoked) with mocked providers.
Manual live check once real clients are connected:

- Refresh across expiry: in the DB set an account's `token_expires_at` to the
  past, click **Refresh calendars**; a new access token is fetched and
  `last_token_use` updates.
- Revocation: revoke the app at the provider (Google Account > Security > Third-
  party access, or the MS account portal), click **Refresh calendars**; the
  account flips to `needs_reauth`, the banner appears, and **Reconnect**
  restores service.

## Deploy

Backend (Supabase cloud):

1. Create a project at supabase.com.
2. `supabase login`, then `supabase link --project-ref <ref>`.
3. `supabase db push` to apply migrations.
4. Dashboard, Auth: set Site URL to the Vercel URL, add
   `https://<app>/auth/confirm` to Redirect URLs, paste
   supabase/templates/magic_link.html into Auth > Email Templates > Magic
   Link, and configure a production SMTP sender. For passkeys, enable them
   and set the WebAuthn rp_id to the production domain.

Frontend (Vercel):

1. Import the repo at vercel.com.
2. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY from the
   cloud project (Settings > API). From Milestone 2 also set (as plain,
   non-public server vars) SUPABASE_SERVICE_ROLE_KEY, APP_BASE_URL (the Vercel
   URL), and the Google/Microsoft OAuth vars from `.env.example`. The service
   role key and client secrets are server-side only; never prefix them
   NEXT_PUBLIC_.
3. Deploy.

## Security model

- Every table: RLS owner-only (user_id = auth.uid()).
- Sign-ups rejected server-side for any email except the allow-listed one
  (trigger on auth.users).
- OAuth refresh and access tokens go into Supabase Vault; the accounts table
  stores only the secret ids. Decryption is server-side only, through
  service-role functions never granted to the browser.
- No document contents or file uploads, by design.

## Calendar, tasks and reminders (Milestone 3)

### Event sync (read path)

On-demand only; there is no background daemon (that is M5). The calendar page
syncs on open when the data is stale (older than 15 minutes) and offers a manual
Refresh. Sync runs across every sync-enabled calendar on all connected accounts.
Each calendar can be toggled for sync under Settings > Accounts; a newly
discovered calendar defaults to on.

Incremental where the provider supports it: Google `syncToken` and Microsoft
Graph `calendarView` delta. The cursor is stored per calendar
(`calendars.sync_token`, added by migration `20260712000100`). When the cursor is
invalidated (HTTP 410) the sync falls back to a full window and reconciles
deletions. Rolling window: 60 days back, 12 months forward.

Every provider call goes through `withResourceAuth`. An account in
`needs_reauth` is skipped; its events stay stale and the M2 amber banner prompts
a reconnect, while the other accounts sync normally. Timestamps are stored UTC
and shown IST; all-day and multi-day events are handled. Events created in the
app carry `source = 'app'` and keep `ext_event_id` for round-trip edits, and a
re-sync never downgrades an app or reminder event to `synced`.

### Event write and the confirmation gate

Events are created and edited on each account's `is_primary_write` calendar;
editing a synced event writes back to its own source calendar. icai is
read-only. Solo events save directly. An event that carries attendees needs an
explicit confirmation ("This will send an invite to N people") enforced in code,
not only in the UI: the server write path refuses an attendee-bearing payload
without the confirmed flag.

### Reminders on Google Calendar

A task with a due date, or an active recurring obligation, writes ONE Google
Calendar event to the reminder-home calendar on ca.tapasnr, with four reminder
overrides at 10080, 4320, 1440 and 0 minutes (7, 3, 1 and 0 days), never four
separate events. `remind_offsets` is stored in days (default {7,3,1,0}) and
mapped to minute overrides; Google allows at most five overrides, each at most 28
days, and the mapping validates this. Google fires the notifications whether the
app is open or closed.

The writer targets only the `is_reminder_home` calendar. It resolves that
calendar from the database and guards it in code (and in tests); there is no
parameter to point it anywhere else. Changing a due date updates the same event
by `ext_event_id`. Completing, dropping or deleting the source removes the event
and closes the reminders row, so no orphan events remain on the calendar.

A recurring obligation becomes one recurring event; the RRULE is derived from
frequency plus due day (plus due month for yearly): monthly
`FREQ=MONTHLY;BYMONTHDAY=<day>`; bi-monthly, quarterly and half-yearly add
`INTERVAL=2/3/6`; yearly `FREQ=YEARLY;BYMONTH=<month>;BYMONTHDAY=<day>`.

Retry behaviour: if ca.tapasnr is in `needs_reauth` when a reminder should be
written, the source row is still saved, `reminders.created` is set false and
"Reminder not set: reconnect ca.tapasnr" is shown inline. A retry sweep runs on
each sync and creates any pending reminder events once the account reconnects.

### Recurring task rule format

`recurring_rule` is `<freq>` or `<freq>:<interval>`, where freq is daily,
weekly, monthly or yearly and interval is a positive integer (default 1), for
example `weekly:2` for fortnightly. Completing an occurrence advances the due
timestamp by one interval, keeping the IST time-of-day, and spawns the next task.

### Notes on this milestone

The calendar is coloured by account (one fixed hue per slot) for legibility on a
phone, and the week view is a readable 7-day agenda rather than a tiny time grid.
`lib/database.types.ts` was hand-updated to match migration `20260712000100`
(this machine has no Docker); run `npm run db:types` to regenerate it once the
local stack is up. Offline proof: `npm run test:m3` (Node 22.18+).
