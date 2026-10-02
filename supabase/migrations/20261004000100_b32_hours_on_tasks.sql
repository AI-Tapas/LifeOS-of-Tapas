-- B32: hours on tasks, against the monthly target.
--
-- Tapas's goal is about 85 billable hours a month. He has no view of the hours
-- he actually puts in, so he logs them on the task himself (no timer, no
-- calendar import). Life OS stores hours and a target and nothing else: no
-- rupee amount is computed from them anywhere (see "Billing" in CLAUDE.md,
-- M6d and B4).
--
-- Nullable or defaulted additions only, nothing backfilled, RLS unchanged
-- (new columns on existing tables).
--
-- NOT applied anywhere when it was written. Apply it before (or with) the
-- deploy of the B32 code: the Tasks page, Home, /unbilled, the Monday brief,
-- Settings and both connectors select these columns.

alter table tasks
  add column if not exists hours_spent numeric(5,2);

alter table tasks
  add constraint tasks_hours_spent_range
    check (hours_spent is null or (hours_spent >= 0 and hours_spent <= 500));

comment on column tasks.hours_spent is
  'Hours Tapas spent on the task, in hundredths, 0 to 500. Null means not logged. His own record: written from the task drawer, or by an agent only when he says so in an instruction.';

alter table assistant_settings
  add column if not exists monthly_hours_target integer not null default 85;

alter table assistant_settings
  add constraint assistant_settings_monthly_hours_target_range
    check (monthly_hours_target between 1 and 400);

comment on column assistant_settings.monthly_hours_target is
  'Billable hours he aims for each month. Edited in Settings under the work stream rates. Hours and a target only: no amount is derived from it.';
