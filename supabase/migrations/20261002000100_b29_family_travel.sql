-- B29: the family travel calendar.
--
-- Life OS keeps ONE separate Google calendar up to date with where Tapas is
-- travelling, and he shares that calendar read-only with his spouse. She may
-- see the city, the session days and each leg's mode, time and route, and
-- nothing else (see lib/family/travel.ts and the B29 section of CLAUDE.md).
--
-- Additive only. NOT applied to any database when this was written.
--
-- 1. calendars.is_family_travel: which calendar that is. Nullable boolean, at
--    most one per user (partial unique index). Written only by the Settings
--    server action in an owner session; no assistant tool or connector names
--    it. RLS is the calendars table's own (owner only).
-- 2. family_travel_events: what Life OS wrote there, so it only ever updates
--    or deletes events it created and recorded, never any other event that
--    happens to be on that calendar.

alter table calendars add column if not exists is_family_travel boolean;

comment on column calendars.is_family_travel is
  'The Google calendar Life OS keeps with the family travel plan. At most one per user. Owner-session write only.';

create unique index if not exists calendars_one_family_travel
  on calendars (user_id) where is_family_travel;

-- The family calendar belongs to the ca_tapasnr account, and is never also
-- the reminder-home (reminders must not land on a calendar he shares) or the
-- account's primary write-back calendar (his own events must not either).
create or replace function public.enforce_family_travel_calendar()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_family_travel then
    if (select slot from public.accounts where id = new.account_id)
         is distinct from 'ca_tapasnr' then
      raise exception
        'the family travel calendar must belong to the ca_tapasnr account';
    end if;
    if new.is_reminder_home then
      raise exception
        'the family travel calendar cannot also be the reminder-home calendar';
    end if;
    if new.is_primary_write then
      raise exception
        'the family travel calendar cannot also be the primary write-back calendar';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_family_travel_calendar on calendars;
create trigger enforce_family_travel_calendar
  before insert or update on calendars
  for each row execute function public.enforce_family_travel_calendar();

create table if not exists family_travel_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Loose link (house rule): deleting a trip must not lose the id of the
  -- Google event, or the event could never be removed. The row is kept with a
  -- null trip_id and the next sync deletes the event, then the row.
  trip_id uuid references trips (id) on delete set null,
  kind text not null check (kind in ('session', 'leg')),
  -- A session's date, or a leg's date, route and occurrence number.
  item_key text not null,
  ext_event_id text not null,
  -- The Google calendar the event was written to. Every later patch and delete
  -- goes to THIS calendar, even if the family calendar has since changed.
  ext_calendar_id text not null,
  -- sha256 of the event payload last written, so an unchanged event is not
  -- written again.
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (user_id, trip_id, kind, item_key)
);

create index if not exists family_travel_events_user_idx on family_travel_events (user_id);

alter table family_travel_events enable row level security;

drop policy if exists owner_all on family_travel_events;
create policy owner_all on family_travel_events
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on table public.family_travel_events from anon;

comment on table family_travel_events is
  'Google events Life OS wrote to the family travel calendar. Ids (event and calendar) and a hash only: no event text, no title, no city. The sync touches only events recorded here.';
