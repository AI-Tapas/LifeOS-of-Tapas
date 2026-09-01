-- Milestone 7a: the calendar is for interrupts, not for the whole task list.
--
-- Every task with a due date wrote its own Google Calendar event at 09:30 IST
-- carrying four notification overrides. One month of AICA travel is six trips
-- at four checklist steps each: about twenty-four stacked entries, up to four
-- notifications apiece, for work that is genuinely routine. The result is a
-- calendar he stops reading, which destroys the value of the reminders that
-- do matter: a client deadline, a statutory filing.
--
-- The rule this migration installs: a calendar reminder is an interruption
-- aimed at his attention on a particular day, so it is reserved for work
-- where missing the date has a real consequence. Everything else is chased by
-- the Home ranking, the trip screen and the 7 AM brief, all of which already
-- reach him whether or not he opens the app.
--
-- Nothing is hidden. An in_app task keeps its due date, keeps its place in
-- the ranking, keeps its line in the brief and still counts in its trip's
-- rollup. Only the Google Calendar event stops being written.

-- ---------------------------------------------------------------------------
-- 1. How a task reminds him.
-- ---------------------------------------------------------------------------
-- calendar : today's behaviour. One event on the reminder-home calendar with
--            the task's remind_offsets. The default, so nothing existing
--            changes meaning.
-- in_app   : no Google Calendar event at all.
--
-- Deliberately NOT the same enum as reminders.channel ('gcal' | 'in_app'),
-- which says how an existing reminder ROW is delivered. This says whether the
-- task asks for a calendar event in the first place.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'reminder_mode') then
    create type reminder_mode as enum ('calendar', 'in_app');
  end if;
end
$$;

alter table tasks
  add column if not exists reminder_mode reminder_mode not null default 'calendar';

comment on column tasks.reminder_mode is
  'calendar: one Google Calendar event on the reminder-home calendar with this task''s remind_offsets. in_app: no calendar event; the task still ranks on Home, still appears in the morning brief and still counts in its trip rollup.';

-- ---------------------------------------------------------------------------
-- 2. Backfill: the routine work stops interrupting him.
-- ---------------------------------------------------------------------------
-- Trip checklist steps. Booking a ticket is routine admin he does in a batch,
-- and the trip screen plus the brief already chase it.
--
-- The one exception is the overseas chapter AED invoice step: it happens once
-- or twice a year and he named forgetting it as the specific risk, so it
-- keeps its calendar event.
update tasks
set reminder_mode = 'in_app'
where trip_id is not null
  and title not like 'Raise the AED invoice%';

-- The recurring monthly invoice task seeded by migration 20260901000300. It
-- has a standing place in his month; it does not need to interrupt him.
update tasks
set reminder_mode = 'in_app'
where title = 'Raise the AICA invoice for last month';

-- SQL cannot delete a Google Calendar event, so the events these rows already
-- wrote are still on his calendar after this migration. They are cleared by
-- the one-off owner-session maintenance action in Settings ("Clear the
-- calendar entries these no longer need"), which walks every in_app task
-- whose reminders row still holds an ext_event_id and removes the event
-- through the normal removeReminder path. It is safe to run twice and is
-- never run automatically on deploy.

-- ---------------------------------------------------------------------------
-- 3. One trip, one calendar entry.
-- ---------------------------------------------------------------------------
-- With the per-step events gone, the calendar would lose sight of the travel
-- itself, which he does want to see. A trip with a start date now writes ONE
-- all-day event spanning its dates on the same reminder-home calendar, with a
-- single reminder the day before rather than the four-offset set.
--
-- The id lives on the trip rather than in reminders: a reminders row belongs
-- to exactly one of task / finance_item / obligation (a check constraint says
-- so), and this is not a reminder about a due date, it is the trip itself.
alter table trips
  add column if not exists ext_event_id text;

comment on column trips.ext_event_id is
  'Google Calendar event id of this trip''s single all-day span event on the reminder-home calendar. Null when the trip has no start date, or when the event could not be written yet.';
