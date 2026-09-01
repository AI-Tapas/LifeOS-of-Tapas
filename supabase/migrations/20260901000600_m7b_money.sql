-- Milestone 7b: money completed.
--
-- The Money screen carried recurring obligations only: gas, electricity, the
-- credit card, insurance. The half that was missing is the half where money is
-- actually at risk. An FD that matures unnoticed rolls over at a worse rate,
-- and a review date that passes is a decision not taken.
--
-- Three changes, all additive. Nothing is dropped and nothing changes meaning
-- for a row already in the database.
--
--   1. Sub-monthly obligation intervals (backlog B2).
--   2. An hourly rate per work stream (backlog B4).
--   3. Comments that pin the confidential boundary onto the investment
--      columns themselves.
--
-- finance_items needs NO new column. It shipped in M1 with exactly the shape
-- this milestone wants: kind, name, institution, value, key_date and
-- key_date_type. Which reminder an investment writes is derived from
-- key_date_type (maturity interrupts on the calendar, a review date stays in
-- the app), so a column saying the same thing a second time would only be
-- something to keep in step.

-- ---------------------------------------------------------------------------
-- 1. Sub-monthly obligation intervals (B2).
-- ---------------------------------------------------------------------------
-- obligation_frequency ran monthly and longer. He needs every N days or weeks
-- as well: a fortnightly payment cannot be said with a due day of the month.
--
-- Tasks have supported exactly this since M1 through tasks.recurring_rule, so
-- this ports that rule rather than inventing a second one. interval_rule takes
-- the same "<freq>:<interval>" text (here restricted to 'daily' and 'weekly',
-- since the monthly family is already in the enum), and anchor_date is the
-- first occurrence the series counts from, which a day-of-month cannot supply.
--
-- The pair is only read when frequency is 'custom'. There is deliberately NO
-- check constraint tying them together: a constraint mentioning 'custom' would
-- be using an enum value added in this same transaction, which Postgres
-- refuses. The rule is enforced in app/(app)/money/actions.ts and in
-- lib/reminders/core.ts, both of which are the only writers.
alter type obligation_frequency add value if not exists 'custom' before 'monthly';

alter table recurring_obligations
  add column if not exists interval_rule text,
  add column if not exists anchor_date date;

comment on column recurring_obligations.interval_rule is
  'Sub-monthly series, same rule format as tasks.recurring_rule: "<freq>:<interval>" where freq is daily or weekly, e.g. "weekly:2" for fortnightly. Read only when frequency is ''custom''.';
comment on column recurring_obligations.anchor_date is
  'First occurrence of a custom series. A sub-monthly series has no day of the month to anchor on, so it counts from this date. Read only when frequency is ''custom''.';

-- ---------------------------------------------------------------------------
-- 2. An hourly rate per work stream (B4).
-- ---------------------------------------------------------------------------
-- The Rs 3,500 per hour floor existed only as a sentence in the assistant's
-- hard rules, which means the model was asked to remember a number instead of
-- reading one. Nullable on purpose: a stream with no rate (Personal) says so
-- by being empty, and no rate is invented here for any stream.
--
-- This milestone stores one number per stream and tells the assistant about
-- it. There is no quoting, no invoicing and no time tracking, and none should
-- be built on top of it without a decision of its own.
alter table work_streams
  add column if not exists hourly_rate numeric(12,2);

comment on column work_streams.hourly_rate is
  'What an hour of this stream is worth, in rupees. Null means no rate is recorded, and the assistant then falls back to the general floor in its hard rules. Not a price list and not a quote: one number the app holds so the underpricing warning can name the stream''s own rate.';

-- ---------------------------------------------------------------------------
-- 3. The confidential boundary, written onto the money columns.
-- ---------------------------------------------------------------------------
-- Money invites exactly the fields this app must never hold. There is no
-- account number, no folio number, no customer id, no statement and no
-- upload path anywhere in this milestone, and there is no column for one.
-- institution is a short human label ("HDFC, Navrangpura") that means
-- something to Tapas and nothing to anybody else.
comment on column finance_items.institution is
  'Where it is held, as a short human label such as "HDFC, Navrangpura". NEVER an account number, a folio number, a customer id or a login. If a value would be useful to somebody impersonating him, it does not belong here.';
comment on column finance_items.key_date is
  'The maturity date where the holding has one, or the review date where it does not. key_date_type says which.';
comment on column finance_items.key_date_type is
  'maturity: money is genuinely at stake on that date, so it writes one Google Calendar reminder with the standard offsets. review: a date to think on, which appears on Home and in the morning brief and never interrupts him.';
comment on column recurring_obligations.account_ref is
  'A short human reference such as "HDFC card", never a full account or card number.';
