-- Milestone 6d: stop billing per trip, start feeding the monthly invoice.
--
-- M6 built a per-trip reimbursement bill addressed to "ICAI <city> Branch"
-- and numbered AICA/2026-27/001. Every one of those specifics was wrong.
-- Tapas bills monthly, to the ICAI AI committee rather than to a branch, from
-- one continuous number series across all his clients (TR-2026-00NN), out of
-- a formula-driven workbook on his own machine. Life OS must hold the month's
-- sessions, legs and expenses accurately and hand them over; it must not
-- produce a bill.
--
-- The bills and billing_profile TABLES are deliberately left in place. They
-- now hold nothing the app reads or writes, and dropping a table is
-- irreversible; a later migration can remove them once this has settled.

-- ---------------------------------------------------------------------------
-- 1. How a trip is billed, as three real cases instead of free text.
-- ---------------------------------------------------------------------------
-- icai_monthly : goes into the monthly ICAI claim. The default.
-- chapter_aed  : overseas chapter (Dubai, Abu Dhabi). Invoiced separately to
--                the chapter in AED, and NEVER on the ICAI invoice.
-- none         : not billable to anyone (leisure, personal).
do $$
begin
  if not exists (select 1 from pg_type where typname = 'trip_bills_to') then
    create type trip_bills_to as enum ('icai_monthly', 'chapter_aed', 'none');
  end if;
end
$$;

alter table trips
  add column if not exists bills_to trip_bills_to not null default 'icai_monthly';

-- Backfill is a no-op beyond the default: every existing row goes to the
-- monthly claim. Dropping billable_to is safe because the only values in it
-- are six branch names Life OS itself wrote from the wrong assumption.
update trips set bills_to = 'icai_monthly' where bills_to is null;

alter table trips drop column if exists billable_to;

-- ---------------------------------------------------------------------------
-- 2. One monthly invoice task instead of a "build the bill" step per trip.
-- ---------------------------------------------------------------------------
-- Seeded once, into the ICAI stream, using the existing recurring-task
-- machinery (tasks.recurring_rule; completing an occurrence advances the due
-- date by one month, lib/tasks/recurring.ts). Due on the 3rd at 9:30 am IST,
-- the app's standard task due time (04:00 UTC).
--
-- Seeded without a calendar reminder row: reminders are written by the app's
-- own task path, and the first completion re-creates this task through that
-- path, which picks the reminder up.
insert into tasks (user_id, title, notes, status, priority, work_stream_id, due_ts, recurring_rule, source)
select
  w.user_id,
  'Raise the AICA invoice for last month',
  'Open Trips, then the month pack at /trips/month, for last month''s sessions, travel legs, expenses and any receipt still missing. Copy it into the invoice workbook run. Life OS does not produce the invoice.',
  'todo',
  'high',
  w.id,
  -- The 3rd of next month at 9:30 am IST.
  (date_trunc('month', (now() at time zone 'Asia/Kolkata')) + interval '1 month' + interval '2 days' + interval '9 hours 30 minutes')
    at time zone 'Asia/Kolkata',
  'monthly:1',
  'manual'
from work_streams w
where w.name = 'ICAI'
  and not exists (
    select 1 from tasks t
    where t.user_id = w.user_id
      and t.title = 'Raise the AICA invoice for last month'
  );
