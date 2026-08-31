-- Milestone 6b: trip checklists.
--
-- The problem: importing one month of ICAI sessions produced 50 tasks, 36 of
-- them travel admin (five checklist steps per outstation trip). Every one sat
-- at the top level of the task list and buried the work that needs judgment.
--
-- The fix is one column, not a new kind of item. A checklist step stays a
-- task, so it keeps its due date, its priority, its undo path and above all
-- its Google Calendar reminder. It simply belongs to a trip, and the app
-- rolls a trip's steps into a single line wherever tasks are ranked.
--
-- on delete set null, not cascade: the M1 policy for loose links
-- (tasks.project_id, bills.trip_id). Deleting a trip must never silently
-- delete work he still has to do; the steps become ordinary tasks again.

alter table tasks
  add column if not exists trip_id uuid references trips (id) on delete set null;

create index if not exists tasks_trip_id_idx on tasks (trip_id);
