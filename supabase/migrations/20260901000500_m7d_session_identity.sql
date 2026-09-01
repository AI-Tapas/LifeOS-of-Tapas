-- M7d: which session is this trip actually for.
--
-- The problem, in Tapas's words: a trip card said "3 to 5 September 2026" and
-- he had to stop and work out which of those days he was actually teaching.
-- Those dates are the TRAVEL span, arrive-the-night-before included. The
-- session date lived only in the notes, as prose.
--
-- Two columns hold what the schedule already tells him:
--
--   session_label  the short form he reads at a glance: L1D2 is AICA Level 1,
--                  Day 2 of that batch's course. Free text on purpose, not an
--                  enum: his schedule carries Level 1, Level 2, Industry and
--                  Foreign programmes and the day runs D1 to D5, and a new
--                  programme must not need a migration.
--   session_date   the day he actually stands up and teaches, which is not
--                  the same as start_date and often not end_date either.
--
-- Both nullable. A trip without them reads exactly as it does today, so
-- nothing already entered becomes wrong or needs guessing at.

alter table trips
  add column if not exists session_label text,
  add column if not exists session_date date;

comment on column trips.session_label is
  'Short session identity read at a glance, e.g. L1D2 (AICA Level 1, Day 2). Free text: the programme list changes without a migration.';
comment on column trips.session_date is
  'The day the session actually runs. Distinct from start_date, which is when travel begins (usually the night before).';

-- The six September trips already carry this in their notes as prose. Filled
-- in from the ICAI schedule Tapas imported, so the first month reads right
-- immediately rather than waiting for him to retype six trips.
update trips set session_label = 'L1D2', session_date = '2026-09-04'
  where title = 'AICA Level 1 batch 912, KPMG Bangalore';
update trips set session_label = 'L2D5', session_date = '2026-09-10'
  where title = 'AICA Level 2 batch 87, Rajkot';
update trips set session_label = 'L1D3', session_date = '2026-09-12'
  where title = 'AICA Level 1 batch 898, KPMG Mumbai';
update trips set session_label = 'L1D1', session_date = '2026-09-17'
  where title = 'AICA Level 1 batch 884, Vadodara';
update trips set session_label = 'L2D4', session_date = '2026-09-22'
  where title = 'AICA Level 2 batch 99, Surat';
update trips set session_label = 'L2D5', session_date = '2026-09-25'
  where title = 'AICA Level 2 batch 95, COE Kolkata';
