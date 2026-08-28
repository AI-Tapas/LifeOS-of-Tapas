-- Milestone 6: Travel Desk.
--
-- trips, trip_expenses and bills shipped in M1 with the exact shapes this
-- milestone needs, so nothing about those columns changes here. Two gaps are
-- closed:
--   1. the trip status trail Tapas actually works to (planned, underway,
--      done, billed),
--   2. the letterhead the reimbursement bill prints from, kept as an editable
--      settings record so no name or address is hardcoded in the app.
--
-- Confidential boundary unchanged: trip_expenses.receipt_ref and bills.pdf_ref
-- stay reference strings. No storage bucket, no upload column, nothing that
-- invites a document into the app.

-- Status trail. 'booked' and 'cancelled' were already in the type and remain
-- valid; the two new values are placed so the enum's own order reads as the
-- trail (planned, booked, underway, done, billed, cancelled).
alter type trip_status add value if not exists 'underway' before 'done';
alter type trip_status add value if not exists 'billed' after 'done';

-- Letterhead for the printed bill: his name and address block, plus the
-- default prefix for the bill number series. One row per user.
create table billing_profile (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name text not null default '',
  -- free text, printed as-is over several lines
  address text not null default '',
  email text,
  phone text,
  -- printed below the total: bank details, membership number, anything he
  -- wants on every bill
  footer text,
  -- series prefix, e.g. AICA in AICA/2026-27/001
  bill_prefix text not null default 'AICA',
  updated_at timestamptz not null default now()
);

alter table billing_profile enable row level security;
create policy owner_all on billing_profile for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Who the bill is addressed to, in full. bills.bill_to is an enum that says
-- WHICH kind of payer (institute, client, other); the printed bill also needs
-- the payer's name and address as free text.
alter table bills add column if not exists bill_to_address text;

create index if not exists trips_start_date_idx on trips (start_date);
create index if not exists bills_trip_id_idx on bills (trip_id);

-- Seed the letterhead row once for the existing owner, and for any future
-- first sign-in, so the Settings panel always has a row to edit.
insert into billing_profile (user_id)
select id from auth.users
on conflict (user_id) do nothing;

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
    (new.id, 'Personal',              'personal',       'NA',                         false)
  on conflict (user_id, name) do nothing;

  insert into public.billing_profile (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
