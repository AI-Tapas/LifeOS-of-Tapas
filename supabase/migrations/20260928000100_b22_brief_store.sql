-- B22: keep the composed 7 AM brief, so the AI workforce can read what Tapas
-- was told this morning (lifeos_get_last_brief on the connector).
--
-- One row per IST day. The brief cron upserts today's row and deletes rows
-- older than 30 days in the same run (lib/brief/store.ts), so the table never
-- holds more than a month. A table rather than an audit row: audit_log is
-- append-only and cannot be trimmed, and the brief carries task titles, some
-- from scanned mail, which do not belong in the audit trail.
--
-- Additive only. RLS as on every table: the owner, and nobody else. The brief
-- cron and the connectors reach it as service_role, like every other table
-- they read, scoping each query to the owner's user_id themselves.

create table if not exists briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  brief_date date not null,
  subject text not null default '',
  body_text text not null default '',
  created_at timestamptz not null default now(),
  unique (user_id, brief_date)
);

alter table briefs enable row level security;

drop policy if exists owner_all on briefs;
create policy owner_all on briefs
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on table public.briefs from anon;

comment on table briefs is
  'The plain-text morning brief as composed, one row per IST day, the last 30 days only. Written by the brief cron, read by lifeos_get_last_brief. No mail body, subject or attachment text: task titles and counts, as the brief itself carries.';
