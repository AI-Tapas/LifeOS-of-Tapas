-- B31 (part 2 of 2): phone alerts and share-to-Life OS capture.
--
-- Two small owner-only tables. No existing table changes.
--
--   push_subscriptions  one row per device that turned alerts on (a Web Push
--                       endpoint plus its two public keys). Sending runs as
--                       service_role; the owner can list and remove his own.
--   capture_tokens      the tokens an Apple Shortcut uses to post text to
--                       /api/capture. Only the sha256 hash is stored, the
--                       token itself is shown to Tapas once. A token can do
--                       exactly one thing: create a capture.
--
-- Confidential boundary: neither table holds any task, mail or document text.
-- Alert wording is never stored (the audit row keeps counts only).
--
-- NOT applied anywhere when it was written. Run after
-- 20261003000100_b31_capture_source.sql.

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device_label text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  last_error_at timestamptz,
  constraint push_subscriptions_label_len check (device_label is null or char_length(device_label) <= 60)
);

create index push_subscriptions_user_id_idx on push_subscriptions (user_id);

create table capture_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  label text not null,
  -- sha256 hex of the token; the token cannot be recovered from here.
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  constraint capture_tokens_label_len check (char_length(label) between 1 and 60)
);

create index capture_tokens_user_id_idx on capture_tokens (user_id);

alter table push_subscriptions enable row level security;
alter table capture_tokens enable row level security;

create policy owner_all on push_subscriptions for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy owner_all on capture_tokens for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- The sender (a cron, the connector) and the capture route reach the database
-- as service_role, which bypasses RLS; it is named here so the grant is plain.
grant select, insert, update, delete on push_subscriptions to service_role;
grant select, insert, update, delete on capture_tokens to service_role;

comment on table push_subscriptions is
  'Devices that turned phone alerts on. Written by the owner session; read and pruned by the sender (service_role). A 404 or 410 from the push service deletes the row.';
comment on table capture_tokens is
  'Share-to-Life OS tokens. Only the sha256 hash is kept. Revoking a token deletes its row. A token is accepted by POST /api/capture and nowhere else.';
