-- Milestone 7c: Brain on screen, health as its own area, one chat thread.
--
-- Three changes, all additive. Nothing is dropped and no existing row changes
-- meaning.
--
--   1. Notes gain the two references they were missing (a task and a trip), so
--      a note can point at the work it came out of.
--   2. A Health work stream, seeded (backlog B5). Health work stops competing
--      inside Personal and becomes a category the ranking can see.
--   3. assistant_chat_turns: the chat transcript moves off the device
--      (backlog B6), so the same thread is on his phone and his laptop.

-- ---------------------------------------------------------------------------
-- 1. What a note is about.
-- ---------------------------------------------------------------------------
-- notes shipped in M1 with people_ids, project_id and work_stream_id. A note
-- about a piece of work could not name that work, and a note from a trip could
-- not name the trip, so both references lived in the body as prose nothing
-- could follow.
--
-- Loose links, so the house rule applies: on delete set null. Deleting a task
-- or a trip must never destroy the note that recorded what happened in it.
alter table notes
  add column if not exists task_id uuid references tasks (id) on delete set null,
  add column if not exists trip_id uuid references trips (id) on delete set null;

create index if not exists notes_task_id_idx on notes (task_id);
create index if not exists notes_trip_id_idx on notes (trip_id);
create index if not exists notes_created_at_idx on notes (created_at desc);

comment on column notes.task_id is
  'The task this note is about, if any. Loose link: deleting the task leaves the note with a null here, never deletes it.';
comment on column notes.trip_id is
  'The trip this note came out of, if any. Loose link, same rule as task_id.';

-- ---------------------------------------------------------------------------
-- 2. Health is an area of its own (backlog B5).
-- ---------------------------------------------------------------------------
-- From the persona interview: he is "absolutely not paying attention" to his
-- health and asked for it to be treated with priority. Today a health task is
-- an ordinary Personal task, so it queues behind the gas bill and the car
-- service and loses every time.
--
-- kind is 'personal' rather than a new enum member on purpose. work_streams.kind
-- is a display label and nothing reads it, and a new enum value could not be
-- used by an insert in the same transaction that adds it (Postgres refuses),
-- which would cost a second migration to buy a word on the Settings screen.
--
-- Existing Personal tasks are deliberately NOT moved. Which of them is health
-- work is his judgment, not a string match on the title.
insert into work_streams (user_id, name, kind, billing_entity, feeds_billing)
select id, 'Health', 'personal', 'NA', false
from auth.users
on conflict (user_id, name) do nothing;

create or replace function public.seed_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.work_streams (user_id, name, kind, billing_entity, feeds_billing)
  values
    (new.id, 'ICAI',                  'training',       'ICAI',                       true),
    (new.id, 'Cygnet',                'consulting',     'Self',                       true),
    (new.id, 'Tax Strategia',         'tax_advisory',   'Tax Strategia Partners LLP', true),
    (new.id, 'Altechon',              'tech_consulting','Altechon',                   true),
    (new.id, 'Individual consulting', 'advisory',       'Self',                       true),
    (new.id, 'Individual training',   'training',       'Self',                       true),
    (new.id, 'Personal',              'personal',       'NA',                         false),
    (new.id, 'Health',                'personal',       'NA',                         false)
  on conflict (user_id, name) do nothing;

  insert into public.billing_profile (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The chat thread, off the device (backlog B6).
-- ---------------------------------------------------------------------------
-- M4 put the transcript in localStorage and said so plainly: device-local on
-- purpose, move it when the same thread is needed on the phone and the laptop
-- at once. That is now the case.
--
-- seq, not created_at, is the order. A user turn and the assistant's reply are
-- written in one statement and would share a now(), which would leave the
-- thread's own order down to luck.
--
-- The transcript is his own words about his own work, so it is as sensitive as
-- assistant_persona and gets the same treatment: owner session only. RLS holds
-- for the browser role; the revoke below holds for the connectors, which reach
-- the database as service_role and so are not scoped by RLS at all. There is no
-- tool that reads this table, and after this revoke there could not be a
-- working one on the connector surface even if somebody wrote it.
create table if not exists assistant_chat_turns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  seq bigint generated always as identity,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  -- The tool chips shown under a reply: name and one-line summary each. Never
  -- tool arguments, and never anything a tool read.
  tools jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists assistant_chat_turns_user_seq_idx
  on assistant_chat_turns (user_id, seq desc);

alter table assistant_chat_turns enable row level security;

drop policy if exists owner_all on assistant_chat_turns;
create policy owner_all on assistant_chat_turns
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on table public.assistant_chat_turns from service_role, anon;

comment on table assistant_chat_turns is
  'The assistant chat transcript. Owner session only: RLS for the browser role, and service_role is revoked so no connector or server-to-server caller can read it. No tool exists that touches this table and none may be added.';
comment on column assistant_chat_turns.seq is
  'Thread order. A user turn and its reply are written together and share a created_at, so ordering by time alone is not deterministic.';
