-- Milestone 8: the quarterly persona refresh, as one recurring task.
--
-- The persona is what makes the assistant sound like Tapas rather than like a
-- model. It was written in one sitting in July 2026 and it will drift: his
-- practice changes, the Life Book notes are still to come, and a persona that
-- is never revisited slowly describes somebody he used to be.
--
-- Every refresh writes a NEW version and never overwrites the old one. That
-- is already how Settings behaves (components/settings/persona-panel.tsx:
-- "Save as new version"); this task exists so the act is remembered, and the
-- note says it in his own screen's words.
--
-- Built on the existing recurring machinery, not a new one: tasks.
-- recurring_rule 'monthly:3' is quarterly (lib/tasks/recurring.ts), and
-- completing an occurrence advances the due date by three months, keeping the
-- IST time of day. No new column, no new table, no scheduler entry.

-- ---------------------------------------------------------------------------
-- 1. The task.
-- ---------------------------------------------------------------------------
-- reminder_mode 'calendar', which M7a reserved for interrupts. Four entries a
-- year is not the calendar clutter M7a removed (that was two dozen routine
-- trip-admin entries a month), and this is the AED-invoice case: rare enough
-- that he will not think of it on his own, and nothing else in his week
-- raises it.
--
-- priority 'medium', not 'high'. B3 made every seeded row count as HIS hand
-- (priority_source defaults to 'manual'), so a 'high' here would sit in the
-- Do-first band on Home for the rest of the year and dilute the band that
-- carries real deadlines. Nothing breaks if this slips by a week.
insert into tasks (
  user_id, title, notes, status, priority, work_stream_id, due_ts,
  recurring_rule, reminder_mode, source
)
select
  w.user_id,
  'Refresh the assistant persona (a new version, never an overwrite)',
  'Open Settings, Assistant persona. Read the active version, then use "Edit as new version" and "Save as new version". Never overwrite: the old version stays readable, which is what makes a change reviewable. Worth a look each quarter: how he decides, what he refuses, how he writes, and anything the last three months changed.',
  'todo',
  'medium',
  w.id,
  -- The first day of the next quarter at 9:30 am IST, the app's standard task
  -- due time (04:00 UTC).
  (date_trunc('quarter', (now() at time zone 'Asia/Kolkata'))
     + interval '3 months' + interval '9 hours 30 minutes')
    at time zone 'Asia/Kolkata',
  'monthly:3',
  'calendar',
  'manual'
from work_streams w
where w.name = 'Personal'
  and not exists (
    select 1 from tasks t
    where t.user_id = w.user_id
      and t.title = 'Refresh the assistant persona (a new version, never an overwrite)'
  );

-- ---------------------------------------------------------------------------
-- 2. The calendar entry the mode promises.
-- ---------------------------------------------------------------------------
-- SQL cannot call the Google Calendar API, so a seeded 'calendar' task would
-- carry a mode that means nothing until he next edits the task. The app
-- already has a path for exactly this state: a reminders row with
-- created = false is what lib/reminders/writer.ts writes when ca.tapasnr is
-- unreachable, and retryPendingReminders (run on every calendar sync) picks
-- those up and creates the event. So the row is written pending, and the
-- first sync after this migration makes it real.
--
-- saveReminderRow updates an existing row rather than inserting a second one,
-- so this cannot produce a duplicate.
insert into reminders (user_id, task_id, remind_ts, channel, created)
select t.user_id, t.id, t.due_ts, 'gcal', false
from tasks t
where t.title = 'Refresh the assistant persona (a new version, never an overwrite)'
  and t.due_ts is not null
  and not exists (
    select 1 from reminders r where r.task_id = t.id
  );
