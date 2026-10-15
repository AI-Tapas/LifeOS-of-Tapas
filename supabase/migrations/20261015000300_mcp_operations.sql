-- Durable connector intents, explicit unknown outcomes, bounded activity and jobs.
-- No connector may approve a send. These tables and RPCs are service-only;
-- the owner can inspect records through RLS, not forge operation completion.
create table public.mcp_operations (
  id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id text not null, idempotency_key text not null, request_hash text not null, tool text not null, scope_hash text not null,
  state text not null default 'running' check(state in ('running','completed','failed','uncertain')),
  result jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,client_id,idempotency_key)
);
create table public.mcp_activity (
  id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id text not null, tool text not null, state text not null default 'started', created_at timestamptz not null default now()
);
create index mcp_activity_budget on public.mcp_activity(user_id,client_id,created_at);
create table public.mcp_jobs (
  id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id text not null, state text not null default 'queued' check(state in ('queued','running','completed','failed','cancelled','uncertain')),
  input jsonb not null, capabilities jsonb not null, result jsonb, cancel_requested boolean not null default false,
  created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz
);
create index mcp_jobs_queue on public.mcp_jobs(state,created_at);
create table public.mcp_previews (
  id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id text not null, table_name text not null check(table_name in ('tasks','notes')), record_id uuid not null,
  version text not null, patch jsonb not null, expires_at timestamptz not null default now()+interval '15 minutes',
  committed_at timestamptz, result jsonb
);
-- Explicit grants: Supabase projects may have permissive default privileges.
revoke all on public.mcp_operations,public.mcp_activity,public.mcp_jobs,public.mcp_previews from public,anon,authenticated;
grant select on public.mcp_operations,public.mcp_activity,public.mcp_jobs,public.mcp_previews to authenticated;
grant all on public.mcp_operations,public.mcp_activity,public.mcp_jobs,public.mcp_previews to service_role;
alter table public.mcp_operations enable row level security;
alter table public.mcp_activity enable row level security;
alter table public.mcp_jobs enable row level security;
alter table public.mcp_previews enable row level security;
create policy owner_read on public.mcp_operations for select to authenticated using(user_id=auth.uid());
create policy owner_read on public.mcp_activity for select to authenticated using(user_id=auth.uid());
create policy owner_read on public.mcp_jobs for select to authenticated using(user_id=auth.uid());
create policy owner_read on public.mcp_previews for select to authenticated using(user_id=auth.uid());

create or replace function public.mcp_service(p_action text,p_owner uuid,p_client text,p_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare o mcp_operations; j mcp_jobs; v mcp_previews; row_before jsonb; row_after jsonb; answer jsonb; aid uuid; n integer;
begin
  if p_action='begin_call' then
    update mcp_operations set state='uncertain',updated_at=now() where user_id=p_owner and state='running' and created_at<now()-interval '10 minutes';
    perform pg_advisory_xact_lock(hashtextextended(p_owner::text||p_client,0));
    select count(*) into n from mcp_activity where user_id=p_owner and client_id=p_client and created_at>now()-interval '1 minute';
    if n>=240 then return jsonb_build_object('error','rate_limited'); end if;
    delete from mcp_activity where user_id=p_owner and created_at<now()-interval '30 days';
    delete from mcp_previews where user_id=p_owner and expires_at<now()-interval '1 day';
    delete from mcp_jobs where user_id=p_owner and finished_at<now()-interval '30 days';
    -- Finished operations are kept 30 days for idempotent retries; running/uncertain ones stay for review.
    delete from mcp_operations where user_id=p_owner and state in ('completed','failed') and updated_at<now()-interval '30 days';
    insert into mcp_activity(user_id,client_id,tool) values(p_owner,p_client,p_args->>'tool') returning id into aid;
    return jsonb_build_object('id',aid);
  elsif p_action='finish_call' then
    update mcp_activity set state=p_args->>'state' where id=(p_args->>'id')::uuid and user_id=p_owner and client_id=p_client;
    return '{}';
  elsif p_action='activity' then
    select coalesce(jsonb_agg(t),'[]') into answer from (select id,tool,state,created_at from mcp_activity where user_id=p_owner and client_id=p_client order by created_at desc,id desc limit 50) t;
    return jsonb_build_object('items',answer,'limit',50,'retention_days',30);
  elsif p_action='reserve' then
    insert into mcp_operations(user_id,client_id,idempotency_key,request_hash,tool,scope_hash) values(p_owner,p_client,p_args->>'key',p_args->>'hash',p_args->>'tool',p_args->>'scope_hash') on conflict do nothing returning * into o;
    if found then return jsonb_build_object('claimed',true,'operation',to_jsonb(o)); end if;
    select * into o from mcp_operations where user_id=p_owner and client_id=p_client and idempotency_key=p_args->>'key';
    return jsonb_build_object('claimed',false,'operation',to_jsonb(o));
  elsif p_action='finish' then
    update mcp_operations set state=p_args->>'state',result=p_args->'result',updated_at=now() where id=(p_args->>'id')::uuid and user_id=p_owner and client_id=p_client and state='running' returning * into o;
    if not found then raise exception 'Operation completion was not persisted'; end if;
    return to_jsonb(o);
  elsif p_action='operation' then
    select * into o from mcp_operations where id=(p_args->>'id')::uuid and user_id=p_owner and client_id=p_client;
    return case when found then to_jsonb(o) else jsonb_build_object('error','not_found') end;
  elsif p_action='start_job' then
    perform pg_advisory_xact_lock(hashtextextended(p_owner::text||':scan-job',0));
    if exists(select 1 from mcp_jobs where user_id=p_owner and state in ('queued','running')) then return jsonb_build_object('error','job_busy'); end if;
    insert into mcp_jobs(user_id,client_id,input,capabilities) values(p_owner,p_client,p_args->'input',p_args->'capabilities') returning * into j;
    return to_jsonb(j)-'capabilities';
  elsif p_action='job' then
    select * into j from mcp_jobs where user_id=p_owner and client_id=p_client and id=(p_args->>'id')::uuid;
    return case when found then to_jsonb(j)-'capabilities' else jsonb_build_object('error','not_found') end;
  elsif p_action='cancel_job' then
    update mcp_jobs set cancel_requested=true,state=case when state='queued' then 'cancelled' else state end,finished_at=case when state='queued' then now() else finished_at end where user_id=p_owner and client_id=p_client and id=(p_args->>'id')::uuid returning * into j;
    return case when found then to_jsonb(j)-'capabilities' else jsonb_build_object('error','not_found') end;
  elsif p_action='claim_job' then
    -- A terminated worker may have produced effects. Never replay it blindly.
    update mcp_jobs set state='uncertain',finished_at=now() where user_id=p_owner and state='running' and started_at<now()-interval '10 minutes';
    select * into j from mcp_jobs where user_id=p_owner and state='queued' order by created_at for update skip locked limit 1;
    if not found then return 'null'; end if;
    update mcp_jobs set state='running',started_at=now() where id=j.id returning * into j;
    return to_jsonb(j);
  elsif p_action='finish_job' then
    update mcp_jobs set state=p_args->>'state',result=p_args->'result',finished_at=now() where id=(p_args->>'id')::uuid and user_id=p_owner and state='running' returning * into j;
    if not found then raise exception 'Job completion was not persisted'; end if;
    return to_jsonb(j)-'capabilities';
  elsif p_action='preview' then
    if p_args->>'table' not in ('tasks','notes') or jsonb_typeof(p_args->'patch')<>'object' then return jsonb_build_object('error','invalid_input'); end if;
    if exists(select 1 from jsonb_object_keys(p_args->'patch') k where k not in ('title',case when p_args->>'table'='tasks' then 'notes' else 'body_md' end)) then return jsonb_build_object('error','unsupported_field'); end if;
    if p_args->'patch' ? 'title' and (jsonb_typeof(p_args->'patch'->'title')<>'string' or length(trim(p_args->'patch'->>'title')) not between 1 and 200) then return jsonb_build_object('error','invalid_title'); end if;
    if length((p_args->'patch')::text)>20000 then return jsonb_build_object('error','input_too_large'); end if;
    execute format('select to_jsonb(t) from public.%I t where id=$1 and user_id=$2',p_args->>'table') into row_before using (p_args->>'id')::uuid,p_owner;
    if row_before is null then return jsonb_build_object('error','not_found'); end if;
    if p_args->'work_streams' is not null and p_args->'work_streams'<>'null'::jsonb and not (p_args->'work_streams' ? coalesce(row_before->>'work_stream_id','')) then return jsonb_build_object('error','permission_denied'); end if;
    insert into mcp_previews(user_id,client_id,table_name,record_id,version,patch) values(p_owner,p_client,p_args->>'table',(p_args->>'id')::uuid,md5(row_before::text),p_args->'patch') returning * into v;
    select jsonb_object_agg(k,jsonb_build_object('before',row_before->k,'after',v.patch->k)) into answer from jsonb_object_keys(v.patch) k;
    return jsonb_build_object('preview_id',v.id,'version',v.version,'expires_at',v.expires_at,'changes',answer,'irreversible',false,'external_effects',false);
  elsif p_action='commit_preview' then
    select * into v from mcp_previews where id=(p_args->>'id')::uuid and user_id=p_owner and client_id=p_client for update;
    if not found then return jsonb_build_object('error','not_found'); end if;
    execute format('select to_jsonb(t) from public.%I t where id=$1 and user_id=$2 for update',v.table_name) into row_before using v.record_id,p_owner;
    if p_args->'work_streams' is not null and p_args->'work_streams'<>'null'::jsonb and not (p_args->'work_streams' ? coalesce(row_before->>'work_stream_id','')) then return jsonb_build_object('error','permission_denied'); end if;
    if v.committed_at is not null then return v.result; end if;
    if v.expires_at<now() then return jsonb_build_object('error','preview_expired'); end if;
    if row_before is null or md5(row_before::text)<>v.version then return jsonb_build_object('error','version_conflict'); end if;
    if v.table_name='tasks' then
      update tasks set title=case when v.patch?'title' then v.patch->>'title' else title end,notes=case when v.patch?'notes' then v.patch->>'notes' else notes end where id=v.record_id and user_id=p_owner;
    else
      update notes set title=case when v.patch?'title' then v.patch->>'title' else title end,body_md=case when v.patch?'body_md' then v.patch->>'body_md' else body_md end where id=v.record_id and user_id=p_owner;
    end if;
    insert into assistant_actions(user_id,kind,mode,status,title,payload,payload_hash,executed_at,execution_state,result)
      values(p_owner,case when v.table_name='tasks' then 'update_task' else 'update_note' end,'auto','executed','Connector preview: update record',v.patch,md5(v.patch::text),now(),'succeeded',jsonb_build_object('undo',jsonb_build_object('kind',case when v.table_name='tasks' then 'update_task' else 'update_note' end,case when v.table_name='tasks' then 'task_id' else 'note_id' end,v.record_id,'patch_only',true,'prev',(select jsonb_object_agg(k,row_before->k) from jsonb_object_keys(v.patch) k)))) returning id into aid;
    insert into audit_log(user_id,actor,action,entity,entity_id,meta) values(p_owner,'assistant','mcp_preview_committed',v.table_name,v.record_id,jsonb_build_object('client_id',p_client,'action_id',aid,'preview_id',v.id));
    answer:=jsonb_build_object('action_id',aid,'affected_ids',jsonb_build_array(v.record_id),'state','completed','undo_available',true);
    update mcp_previews set committed_at=now(),result=answer where id=v.id;
    return answer;
  else raise exception 'Unknown connector operation'; end if;
end $$;
revoke all on function public.mcp_service(text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.mcp_service(text,uuid,text,jsonb) to service_role;
