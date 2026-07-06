-- Single-user auth: only the allow-listed email may ever get an auth.users
-- row (enforced server-side, regardless of client), and the first sign-in
-- seeds the work_streams reference data.

create or replace function public.enforce_signup_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(new.email) is distinct from 'tapas.tnr@gmail.com' then
    raise exception 'sign-ups are disabled for this application';
  end if;
  return new;
end;
$$;

create trigger enforce_signup_allowlist
  before insert on auth.users
  for each row execute function public.enforce_signup_allowlist();

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
  return new;
end;
$$;

create trigger seed_new_user
  after insert on auth.users
  for each row execute function public.seed_new_user();
