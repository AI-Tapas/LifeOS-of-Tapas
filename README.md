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
2. Set env vars NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
   from the cloud project (Settings > API). Nothing else is needed; the
   service role key must never be set in Vercel for this milestone.
3. Deploy.

## Security model

- Every table: RLS owner-only (user_id = auth.uid()).
- Sign-ups rejected server-side for any email except the allow-listed one
  (trigger on auth.users).
- OAuth refresh tokens (later milestones) go into Supabase Vault; the
  accounts table stores only the secret id.
- No document contents or file uploads, by design.
