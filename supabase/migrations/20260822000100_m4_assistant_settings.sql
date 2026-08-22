-- Milestone 4 follow-up: per-activity model choice from the Settings screen.
-- Only the provider NAME and model id live here; API keys stay in server-side
-- environment variables and are never stored in, or reachable from, the
-- database. A null value means "use the server default" (LLM_PROVIDER).

create table assistant_settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  -- interactive assistant chat
  chat_provider text,
  chat_model text,
  -- on-demand mail-to-task scan
  scan_provider text,
  scan_model text,
  updated_at timestamptz not null default now()
);

alter table assistant_settings enable row level security;
create policy owner_all on assistant_settings for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
