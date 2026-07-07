-- Life OS Milestone 2: app-level OAuth account connections.
--
-- Extends the accounts table with the OAuth slot identity, connection status,
-- client kind and a cached-access-token metadata set. Adds Vault wrapper
-- functions (service_role only) so refresh and access tokens live encrypted in
-- Vault with only the secret id kept in the row; no client path can decrypt.
-- Also enforces the calendar write-back and reminder-home rules.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type account_status as enum
  ('connected', 'needs_reauth', 'forwarded', 'disconnected');
create type oauth_client as enum
  ('google_internal', 'google_external', 'microsoft');

-- ---------------------------------------------------------------------------
-- accounts: slot identity, status, client kind, cached-token metadata
-- ---------------------------------------------------------------------------
alter table accounts
  add column slot text,
  add column status account_status not null default 'disconnected',
  add column oauth_client oauth_client,
  -- Vault secret id for the short-lived access token (refresh_token_enc holds
  -- the durable one). Both are ids into vault.secrets, decrypted server-side
  -- only via the functions below. Never selected by any client path.
  add column access_token_enc uuid,
  add column token_expires_at timestamptz,
  add column last_token_use timestamptz;

-- One accounts row per named slot. Full (not partial) unique so upserts can
-- target (user_id, slot); multiple NULL slots stay allowed (NULLs distinct).
alter table accounts add constraint accounts_user_slot_key unique (user_id, slot);

-- ---------------------------------------------------------------------------
-- Vault token store: service_role only, decryption never reaches a client
-- ---------------------------------------------------------------------------
create extension if not exists supabase_vault with schema vault;

-- Store or roll an account's tokens. Pass only the parts that changed:
--   connect        -> refresh + access + expiry
--   google refresh -> access + expiry (refresh stays)
--   microsoft roll -> refresh + access + expiry (Microsoft rotates refresh)
create or replace function public.set_account_tokens(
  p_account_id uuid,
  p_refresh text default null,
  p_access text default null,
  p_access_expires timestamptz default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refresh_id uuid;
  v_access_id uuid;
begin
  select refresh_token_enc, access_token_enc
    into v_refresh_id, v_access_id
    from public.accounts where id = p_account_id;

  if p_refresh is not null then
    if v_refresh_id is null then
      v_refresh_id := vault.create_secret(
        p_refresh, 'account_' || p_account_id::text || '_refresh');
      update public.accounts set refresh_token_enc = v_refresh_id
        where id = p_account_id;
    else
      perform vault.update_secret(v_refresh_id, p_refresh);
    end if;
  end if;

  if p_access is not null then
    if v_access_id is null then
      v_access_id := vault.create_secret(
        p_access, 'account_' || p_account_id::text || '_access');
      update public.accounts set access_token_enc = v_access_id
        where id = p_account_id;
    else
      perform vault.update_secret(v_access_id, p_access);
    end if;
    update public.accounts
      set token_expires_at = p_access_expires,
          last_token_use = now()
      where id = p_account_id;
  end if;
end;
$$;

create or replace function public.get_account_tokens(p_account_id uuid)
returns table (
  refresh_token text,
  access_token text,
  token_expires_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select
    (select decrypted_secret from vault.decrypted_secrets
       where id = a.refresh_token_enc),
    (select decrypted_secret from vault.decrypted_secrets
       where id = a.access_token_enc),
    a.token_expires_at
  from public.accounts a
  where a.id = p_account_id;
$$;

create or replace function public.clear_account_tokens(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refresh_id uuid;
  v_access_id uuid;
begin
  select refresh_token_enc, access_token_enc
    into v_refresh_id, v_access_id
    from public.accounts where id = p_account_id;
  if v_refresh_id is not null then
    delete from vault.secrets where id = v_refresh_id;
  end if;
  if v_access_id is not null then
    delete from vault.secrets where id = v_access_id;
  end if;
  update public.accounts
    set refresh_token_enc = null,
        access_token_enc = null,
        token_expires_at = null
    where id = p_account_id;
end;
$$;

-- Only the server (service_role) may touch tokens. Revoking from PUBLIC also
-- removes the inherited anon/authenticated grant, so no browser path decrypts.
revoke all on function public.set_account_tokens(uuid, text, text, timestamptz) from public;
revoke all on function public.get_account_tokens(uuid) from public;
revoke all on function public.clear_account_tokens(uuid) from public;
grant execute on function public.set_account_tokens(uuid, text, text, timestamptz) to service_role;
grant execute on function public.get_account_tokens(uuid) to service_role;
grant execute on function public.clear_account_tokens(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Calendar selection rules
-- ---------------------------------------------------------------------------
-- At most one write-back calendar per account; at most one reminder-home per
-- user. "Exactly one" reminder-home is set by the app; the DB guards at-most.
create unique index calendars_one_primary_write
  on calendars (account_id) where is_primary_write;
create unique index calendars_one_reminder_home
  on calendars (user_id) where is_reminder_home;

-- The reminder-home calendar must belong to the ca_tapasnr account.
create or replace function public.enforce_reminder_home_slot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_reminder_home then
    if (select slot from public.accounts where id = new.account_id)
         is distinct from 'ca_tapasnr' then
      raise exception
        'reminder-home calendar must belong to the ca_tapasnr account';
    end if;
  end if;
  return new;
end;
$$;

create trigger enforce_reminder_home_slot
  before insert or update on calendars
  for each row execute function public.enforce_reminder_home_slot();
