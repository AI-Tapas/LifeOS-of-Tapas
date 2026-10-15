-- One owner scan at a time across UI, cron, direct MCP and background jobs.
-- Transport-specific daily claims / operation keys cannot serialize each other.
create table public.scan_execution (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade unique,
  run_id uuid not null default gen_random_uuid(),
  status text not null check(status in ('running','released','uncertain')),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
alter table public.scan_execution enable row level security;
create policy owner_read on public.scan_execution for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.scan_execution from public,anon,authenticated,service_role;
grant select on public.scan_execution to authenticated,service_role;

create function public.claim_scan_execution(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.scan_execution; claimed boolean := false;
begin
  if auth.role() is distinct from 'service_role' and auth.uid() is distinct from p_user_id then
    raise exception 'Owner authorization required' using errcode='42501';
  end if;
  insert into public.scan_execution(user_id,status) values(p_user_id,'running')
    on conflict(user_id) do nothing returning * into r;
  if found then claimed := true;
  else
    select * into strict r from public.scan_execution where user_id=p_user_id for update;
    if r.status='released' then
      update public.scan_execution set run_id=gen_random_uuid(),status='running',started_at=now(),finished_at=null
        where user_id=p_user_id returning * into r;
      claimed := true;
    elsif r.status in ('running','uncertain') and r.started_at<now()-interval '2 hours' then
      -- Bounded takeover: a claim that has been stuck for 2 hours must not jam scans for good.
      -- Duplicate tasks are refused by the near-duplicate guard, so a re-run is acceptable.
      insert into public.audit_log(user_id,actor,action,entity,meta)
        values(p_user_id,'assistant','scan_claim_taken_over','scan',
          jsonb_build_object('previous_run_id',r.run_id,'previous_status',r.status,'previous_started_at',r.started_at,'reason','stale_scan_claim'));
      update public.scan_execution set run_id=gen_random_uuid(),status='running',started_at=now(),finished_at=null
        where user_id=p_user_id returning * into r;
      claimed := true;
    elsif r.status='running' and r.started_at<now()-interval '10 minutes' then
      update public.scan_execution set status='uncertain' where user_id=p_user_id returning * into r;
    end if;
  end if;
  return jsonb_build_object('claimed',claimed,'run_id',r.run_id,'status',r.status);
end $$;

create function public.release_scan_execution(p_user_id uuid,p_run_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' and auth.uid() is distinct from p_user_id then
    raise exception 'Owner authorization required' using errcode='42501';
  end if;
  update public.scan_execution set status='released',finished_at=now()
    where user_id=p_user_id and run_id=p_run_id and status='running';
  return found;
end $$;
revoke all on function public.claim_scan_execution(uuid),public.release_scan_execution(uuid,uuid) from public,anon;
grant execute on function public.claim_scan_execution(uuid),public.release_scan_execution(uuid,uuid) to authenticated,service_role;
