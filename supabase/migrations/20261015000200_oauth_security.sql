-- Atomic OAuth issuance, rotation and disconnect. All lifecycle writes use
-- service-only transactions with a consistent client -> grant lock order.
-- Existing live connections keep working with exactly the access they had
-- before (full capabilities, no new access): their clients become approved with
-- no registration expiry and their live access/refresh grants stay valid.
-- Clients with no live grant, and any in-flight authorization codes, are revoked.
alter table public.mcp_clients
  add column capabilities jsonb,
  add column approved_at timestamptz,
  add column revoked_at timestamptz,
  add column registration_expires_at timestamptz not null default (now() + interval '24 hours'),
  add constraint mcp_clients_owner_client_unique unique (user_id, client_id);

alter table public.mcp_grants add column family_id uuid not null default gen_random_uuid();
-- A registration deleted by an older release can have surviving grants.
delete from public.mcp_grants g where not exists (
  select 1 from public.mcp_clients c where c.client_id = g.client_id and c.user_id = g.user_id
);
alter table public.mcp_grants add constraint mcp_grants_client_fk
  foreign key (user_id, client_id) references public.mcp_clients (user_id, client_id) on delete cascade;
-- Keep live connections (unrevoked, unexpired access or refresh grant) working.
-- Capabilities live on the client row and are enforced on every call, so an
-- all-true set equals the unrestricted access these connections already had.
with kept as (
  update public.mcp_clients c set approved_at = now(), registration_expires_at = timestamptz '9999-12-31',
    capabilities = '{"read":true,"write":true,"mail_body":true,"attachments":true,"persona":true,"finance":true,"mailboxes":null,"work_streams":null}'::jsonb
  where exists (select 1 from public.mcp_grants g where g.client_id = c.client_id and g.user_id = c.user_id
    and g.kind in ('access','refresh') and g.revoked_at is null and g.expires_at > now())
  returning c.user_id, c.client_id, c.client_name
)
insert into public.audit_log(user_id, actor, action, entity, meta)
  select user_id, 'assistant', 'mcp_connection_kept_on_migration', 'mcp_clients',
    jsonb_build_object('client_id', client_id, 'client_name', client_name, 'capabilities', 'unchanged_full_access')
  from kept;
-- Revoke everything else: codes, expired grants, and grants of clients with nothing live.
update public.mcp_grants set revoked_at = coalesce(revoked_at, now())
  where revoked_at is null and (kind = 'code' or expires_at <= now()
    or client_id not in (select client_id from public.mcp_clients where approved_at is not null));
create index mcp_grants_family_idx on public.mcp_grants (client_id, family_id);
create index mcp_clients_registration_idx on public.mcp_clients (user_id, created_at);

create function public.oauth_register_client(p_user_id uuid, p_client_id text, p_client_name text, p_redirect_uris text[])
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- A database-wide owner budget cannot be bypassed by spoofing proxy IP headers.
  perform pg_advisory_xact_lock(741892, hashtext(p_user_id::text));
  delete from public.mcp_clients where user_id = p_user_id and approved_at is null
    and registration_expires_at < now();
  if p_client_name is null or p_redirect_uris is null or length(p_client_name) not between 1 and 120 or cardinality(p_redirect_uris) not between 1 and 10 then
    return jsonb_build_object('ok', false, 'error', 'invalid_client_metadata');
  end if;
  if (select count(*) from public.mcp_clients where user_id = p_user_id and created_at > now() - interval '1 hour') >= 30
    or (select count(*) from public.mcp_clients where user_id = p_user_id and approved_at is null and revoked_at is null) >= 100 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  insert into public.mcp_clients(user_id, client_id, client_name, redirect_uris)
    values (p_user_id, p_client_id, p_client_name, p_redirect_uris);
  return jsonb_build_object('ok', true);
end $$;

create function public.oauth_approve_client(p_user_id uuid, p_client_id text, p_redirect_uri text,
  p_code_challenge text, p_code_hash text, p_capabilities jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.mcp_clients%rowtype;
begin
  select * into c from public.mcp_clients where client_id = p_client_id and user_id = p_user_id for update;
  if not found or c.revoked_at is not null or (c.approved_at is null and c.registration_expires_at <= clock_timestamp()) then
    return jsonb_build_object('ok', false, 'error', 'invalid_client');
  end if;
  if p_redirect_uri is null or p_code_challenge is null or p_code_hash is null or not (p_redirect_uri = any(c.redirect_uris)) or p_code_challenge !~ '^[A-Za-z0-9_-]{43}$'
    or p_code_hash !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_capabilities) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;
  -- Changing consent revokes earlier grants, including in-flight codes.
  update public.mcp_grants set revoked_at = coalesce(revoked_at, now()) where client_id = p_client_id;
  update public.mcp_clients set capabilities = p_capabilities, approved_at = now() where id = c.id;
  insert into public.mcp_grants(user_id, client_id, kind, token_hash, redirect_uri, code_challenge, expires_at)
    values (p_user_id, p_client_id, 'code', p_code_hash, p_redirect_uri, p_code_challenge, now() + interval '5 minutes');
  insert into public.audit_log(user_id, actor, action, entity, meta)
    values (p_user_id, 'user', 'mcp_connection_approved', 'mcp_clients',
      jsonb_build_object('client_id', p_client_id, 'client_name', c.client_name, 'capabilities', p_capabilities));
  return jsonb_build_object('ok', true);
end $$;

create function public.oauth_exchange_grant(p_client_id text, p_kind text, p_token_hash text,
  p_redirect_uri text, p_code_challenge text, p_access_hash text, p_refresh_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.mcp_clients%rowtype; g public.mcp_grants%rowtype;
begin
  select * into c from public.mcp_clients where client_id = p_client_id for update;
  if not found or c.revoked_at is not null or c.approved_at is null or c.capabilities is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_grant');
  end if;
  select * into g from public.mcp_grants where client_id = p_client_id and token_hash = p_token_hash for update;
  if not found or g.user_id <> c.user_id or p_kind is null or p_kind not in ('code', 'refresh') or g.kind::text <> p_kind then
    return jsonb_build_object('ok', false, 'error', 'invalid_grant');
  end if;
  if p_kind = 'code' and (g.redirect_uri is distinct from p_redirect_uri or g.code_challenge is distinct from p_code_challenge) then
    return jsonb_build_object('ok', false, 'error', 'invalid_grant');
  end if;
  if g.used_at is not null then
    -- Retain rotated refresh rows to detect replay and invalidate descendants.
    -- Return normally so revocation commits; raising would roll it back.
    update public.mcp_grants set revoked_at = coalesce(revoked_at, now())
      where client_id = p_client_id and family_id = g.family_id;
    return jsonb_build_object('ok', false, 'error', 'invalid_grant');
  end if;
  if g.revoked_at is not null or g.expires_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'error', 'invalid_grant');
  end if;
  if p_access_hash is null or p_refresh_hash is null or p_access_hash !~ '^[a-f0-9]{64}$' or p_refresh_hash !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;
  update public.mcp_grants set used_at = now(), revoked_at = case when p_kind = 'refresh' then now() else revoked_at end where id = g.id;
  insert into public.mcp_grants(user_id, client_id, kind, token_hash, expires_at, family_id) values
    (g.user_id, p_client_id, 'access', p_access_hash, now() + interval '1 hour', g.family_id),
    (g.user_id, p_client_id, 'refresh', p_refresh_hash, now() + interval '90 days', g.family_id);
  update public.mcp_clients set last_used_at = now() where id = c.id;
  return jsonb_build_object('ok', true, 'user_id', g.user_id);
end $$;

create function public.oauth_disconnect_client(p_user_id uuid, p_client_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.mcp_clients%rowtype;
begin
  select * into c from public.mcp_clients where client_id = p_client_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'invalid_client'); end if;
  update public.mcp_clients set revoked_at = coalesce(revoked_at, now()) where id = c.id;
  update public.mcp_grants set revoked_at = coalesce(revoked_at, now()) where client_id = p_client_id;
  insert into public.audit_log(user_id, actor, action, entity, meta)
    values (p_user_id, 'user', 'mcp_connection_revoked', 'mcp_clients', jsonb_build_object('client_id', p_client_id));
  return jsonb_build_object('ok', true);
end $$;

create function public.oauth_revoke_token(p_client_id text, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare found_client text; g public.mcp_grants%rowtype;
begin
  select client_id into found_client from public.mcp_grants where token_hash = p_token_hash;
  if found_client is null or (p_client_id <> '' and p_client_id <> found_client) then return jsonb_build_object('ok', true); end if;
  perform 1 from public.mcp_clients where client_id = found_client for update;
  select * into g from public.mcp_grants where token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('ok', true); end if;
  update public.mcp_grants set revoked_at = coalesce(revoked_at, now())
    where client_id = found_client and (id = g.id or (g.kind = 'refresh' and family_id = g.family_id));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.oauth_register_client(uuid,text,text,text[]),
  public.oauth_approve_client(uuid,text,text,text,text,jsonb),
  public.oauth_exchange_grant(text,text,text,text,text,text,text),
  public.oauth_disconnect_client(uuid,text), public.oauth_revoke_token(text,text) from public, anon, authenticated;
grant execute on function public.oauth_register_client(uuid,text,text,text[]),
  public.oauth_approve_client(uuid,text,text,text,text,jsonb),
  public.oauth_exchange_grant(text,text,text,text,text,text,text),
  public.oauth_disconnect_client(uuid,text), public.oauth_revoke_token(text,text) to service_role;
