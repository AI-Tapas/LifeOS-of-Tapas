-- B19: nothing shown before it can start.
--
-- Tapas, 26 September 2026: the October and the November invoice were both
-- sitting in "urgent" in September. Unless and until September is over there
-- is no point starting the October invoice, let alone the November one. A due
-- date alone cannot say that: it says when work must be finished, never when
-- it can begin.
--
-- not_before is the IST calendar date before which the task cannot sensibly
-- start. Until then every ranked or listed-for-action surface (Home, the
-- Tasks overview, the 7 AM brief, lifeos_list_tasks by default) leaves the
-- task out and counts it instead ("3 waiting for their start date"), and it
-- is never urgent whatever its due date. The Board tab still lists it, so
-- nothing becomes unreachable.
--
-- A date, not a timestamp: "after September ends" is a day, and comparing it
-- with today's IST date needs no time-zone arithmetic.
--
-- Nullable with no default, so every existing row means what it meant
-- before: available now. Nothing is backfilled. Which existing tasks are
-- premature is his call; scripts/report-premature-tasks.ts lists candidates
-- for him to review and changes nothing.

alter table tasks
  add column if not exists not_before date;

comment on column tasks.not_before is
  'IST date before which the task cannot sensibly start. Hidden from ranked lists and never urgent until then. Null means available now.';

-- A start date after the due date would hide a task until it is already
-- overdue, which is exactly the failure this app exists to prevent. The app
-- refuses it with a readable message first (lib/tasks/triage.ts
-- startDateProblem); this is the belt under that, for every writer.
alter table tasks
  drop constraint if exists tasks_not_before_by_due;
alter table tasks
  add constraint tasks_not_before_by_due check (
    not_before is null
    or due_ts is null
    or not_before <= (due_ts at time zone 'Asia/Kolkata')::date
  );

-- RLS is unchanged: a new column on an existing table inherits its policies.
