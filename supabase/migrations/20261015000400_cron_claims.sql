-- Review U3: durable atomic cron ownership; only a known pre-dispatch failure
-- may retry automatically. Uncertain work requires owner/operator reconciliation.
create table public.cron_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  job text not null check (job in ('scan', 'brief')),
  ist_date date not null,
  run_id uuid not null default gen_random_uuid(),
  status text not null check (status in ('running', 'succeeded', 'failed', 'uncertain')),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  result jsonb not null default '{}'::jsonb,
  unique (user_id, job, ist_date)
);
alter table public.cron_runs enable row level security;
create policy owner_read on public.cron_runs for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.cron_runs from anon, authenticated;
grant select on public.cron_runs to authenticated;
-- All mutations go through the fenced functions, including service-role callers.
revoke all on public.cron_runs from service_role;
grant select on public.cron_runs to service_role;

-- Preserve today's deduplication when deploying over the audit-based guard.
-- A legacy start or skipped send has no reliable dispatch boundary, so it
-- requires reconciliation. Never send a second brief merely due to rollout.
insert into public.cron_runs(user_id, job, ist_date, status, started_at, updated_at, result)
select distinct on (user_id, split_part(action, '_', 2), meta->>'ist_date')
  user_id, split_part(action, '_', 2), (meta->>'ist_date')::date,
  case when action in ('cron_scan', 'cron_brief') then 'succeeded'
       when action in ('cron_scan_failed', 'cron_brief_failed') then 'failed'
       else 'uncertain' end,
  ts, ts, jsonb_build_object('reason', 'migrated_legacy_audit')
from public.audit_log
where action in ('cron_scan', 'cron_brief', 'cron_scan_started', 'cron_brief_started',
                 'cron_scan_failed', 'cron_brief_failed', 'cron_brief_skipped')
  and meta->>'ist_date' ~ '^\d{4}-\d{2}-\d{2}$'
order by user_id, split_part(action, '_', 2), meta->>'ist_date',
  case when action in ('cron_scan', 'cron_brief') then 0 else 1 end, ts desc
on conflict do nothing;

create function public.claim_cron_run(p_user_id uuid, p_job text, p_ist_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.cron_runs; claimed boolean := false;
begin
  if p_job not in ('scan', 'brief') then raise exception 'Unknown cron job'; end if;
  insert into public.cron_runs(user_id, job, ist_date, status)
    values (p_user_id, p_job, p_ist_date, 'running')
    on conflict do nothing returning * into r;
  if found then
    claimed := true;
  else
    select * into strict r from public.cron_runs
      where user_id = p_user_id and job = p_job and ist_date = p_ist_date for update;
    if r.status = 'failed' then
      update public.cron_runs set status = 'running', run_id = gen_random_uuid(),
        started_at = now(), updated_at = now(), result = '{}'::jsonb
        where user_id = p_user_id and job = p_job and ist_date = p_ist_date returning * into r;
      claimed := true;
    elsif r.status = 'running' and r.started_at < now() - interval '10 minutes' then
      update public.cron_runs set status = 'uncertain', updated_at = now(),
        result = '{"reason":"interrupted_run"}'::jsonb
        where user_id = p_user_id and job = p_job and ist_date = p_ist_date returning * into r;
      insert into public.audit_log(user_id, actor, action, entity, meta)
        values (p_user_id, 'assistant', 'cron_' || p_job || '_uncertain', 'cron',
          jsonb_build_object('ist_date', p_ist_date, 'run_id', r.run_id, 'reason', 'interrupted_run'));
    end if;
  end if;
  if claimed then
    insert into public.audit_log(user_id, actor, action, entity, meta)
      values (p_user_id, 'assistant', 'cron_' || p_job || '_started', 'cron',
        jsonb_build_object('ist_date', p_ist_date, 'run_id', r.run_id));
  end if;
  return jsonb_build_object('claimed', claimed, 'run_id', r.run_id, 'status', r.status);
end $$;

-- Write-ahead dispatch marker. A killed process or lost HTTP response after
-- this point must never make a later invocation send a second email.
create function public.mark_cron_dispatch(p_user_id uuid, p_job text, p_ist_date date, p_run_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_job <> 'brief' then raise exception 'Only brief dispatch is supported'; end if;
  update public.cron_runs set status = 'uncertain', updated_at = now(),
    result = '{"reason":"provider_dispatch_started"}'::jsonb
    where user_id = p_user_id and job = p_job and ist_date = p_ist_date
      and run_id = p_run_id and status = 'running';
  return found;
end $$;

create function public.finish_cron_run(p_user_id uuid, p_job text, p_ist_date date,
  p_run_id uuid, p_status text, p_result jsonb default '{}'::jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('succeeded', 'failed', 'uncertain') then raise exception 'Invalid terminal state'; end if;
  update public.cron_runs set status = p_status, updated_at = now(), result = coalesce(p_result, '{}'::jsonb)
    where user_id = p_user_id and job = p_job and ist_date = p_ist_date and run_id = p_run_id
      and (status = 'running' or (status = 'uncertain' and p_status in ('succeeded', 'uncertain')));
  if not found then return false; end if;
  insert into public.audit_log(user_id, actor, action, entity, meta)
    values (p_user_id, 'assistant', 'cron_' || p_job || case when p_status = 'succeeded' then '' else '_' || p_status end,
      'cron', coalesce(p_result, '{}'::jsonb) || jsonb_build_object('ist_date', p_ist_date, 'run_id', p_run_id));
  return true;
end $$;

revoke all on function public.claim_cron_run(uuid, text, date) from public, anon, authenticated;
revoke all on function public.mark_cron_dispatch(uuid, text, date, uuid) from public, anon, authenticated;
revoke all on function public.finish_cron_run(uuid, text, date, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_cron_run(uuid, text, date) to service_role;
grant execute on function public.mark_cron_dispatch(uuid, text, date, uuid) to service_role;
grant execute on function public.finish_cron_run(uuid, text, date, uuid, text, jsonb) to service_role;
