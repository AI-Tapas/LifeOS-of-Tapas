-- Milestone 8: clear the billing debt M6d deliberately left behind.
--
-- M6d stopped this app producing a bill of any kind (see "Billing: what this
-- app does NOT do" in CLAUDE.md). It left the bills and billing_profile
-- tables in place for one reason only: dropping a table cannot be undone, and
-- two build sessions were running at the time. Both conditions have passed,
-- nothing in the app has read or written either table since, and a table
-- nobody reads is an invitation to rebuild the thing that was removed.
--
-- THIS MIGRATION DESTROYS DATA IF ANY EXISTS, so it refuses to run rather
-- than doing that quietly. The guard below stops the whole migration if:
--   * any bills row exists at all, or
--   * any billing_profile row holds anything a person typed.
-- A billing_profile row whose every column is still the default is the row
-- migration 20260828000100 seeded itself, and it is bookkeeping rather than
-- his data, so it is not a reason to stop.
--
-- If this migration fails, do not "fix" it by weakening the guard. Read the
-- rows, decide with Tapas what they are, and only then proceed.

do $$
declare
  n_bills bigint := 0;
  n_typed bigint := 0;
begin
  if to_regclass('public.bills') is not null then
    execute 'select count(*) from public.bills' into n_bills;
    if n_bills > 0 then
      raise exception
        'M8 stopped: % row(s) in public.bills. Nothing has written that table since M6d, so read them before anything is dropped.',
        n_bills;
    end if;
  end if;

  if to_regclass('public.billing_profile') is not null then
    execute $q$
      select count(*) from public.billing_profile
      where coalesce(name, '') <> ''
         or coalesce(address, '') <> ''
         or email is not null
         or phone is not null
         or footer is not null
         or coalesce(bill_prefix, '') <> 'AICA'
    $q$ into n_typed;
    if n_typed > 0 then
      raise exception
        'M8 stopped: % billing_profile row(s) hold typed content, not just the seeded defaults. Read them before anything is dropped.',
        n_typed;
    end if;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. The tables, and the enums that existed only to serve them.
-- ---------------------------------------------------------------------------
-- Their indexes and RLS policies go with the tables. bills.trip_id was the
-- only reference either table held, so no other table loses a column.
drop table if exists public.bills;
drop table if exists public.billing_profile;

drop type if exists bill_recipient;
drop type if exists bill_status;

-- ---------------------------------------------------------------------------
-- 2. The seed trigger stops creating a letterhead row.
-- ---------------------------------------------------------------------------
-- Same function as migration 20260901000700, minus the billing_profile
-- insert, which would now fail on any future first sign-in.
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
  return new;
end;
$$;
