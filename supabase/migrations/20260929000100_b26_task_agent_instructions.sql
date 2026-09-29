-- B26: instructions for agents on each task.
--
-- Tapas writes an instruction on a task in the app; the daytime agent sweeps
-- read it through the connector, do the work inside their own guardrails and
-- write a result and a status back. An instruction is an ORDER to an agent, so
-- only Tapas may ever write one: the mail scan turns untrusted email into
-- tasks, and the connector is reachable by outside models. If either could
-- write an instruction, an email could plant orders.
--
-- Nullable additions only, nothing backfilled, RLS unchanged (new columns on
-- an existing table inherit its policies).
--
-- NOT applied anywhere when it was written. Apply it before (or with) the
-- deploy of the B26 code: the Tasks page, Home and both connectors select
-- these columns.
--
-- Why a trigger and not a column-level revoke: the connectors, crons and the
-- scan reach the database as service_role, which bypasses RLS. A column-level
-- REVOKE UPDATE (agent_instructions) from service_role would look like the
-- answer, but Postgres keeps a table-level UPDATE grant alongside column
-- grants, and the table-level grant still allows every column, so the revoke
-- changes nothing. (Revoking the table-level grant would break every other
-- task write from the connectors.) A trigger sees the caller, so it can say
-- "only the owner's own session".

alter table tasks
  add column if not exists agent_instructions text,
  add column if not exists agent_instructions_at timestamptz,
  add column if not exists agent_status text,
  add column if not exists agent_result text,
  add column if not exists agent_result_at timestamptz,
  add column if not exists agent_done_hash text;

alter table tasks
  add constraint tasks_agent_instructions_len
    check (agent_instructions is null or char_length(agent_instructions) <= 2000),
  add constraint tasks_agent_status_values
    check (agent_status is null or agent_status in ('done', 'needs_you')),
  add constraint tasks_agent_result_len
    check (agent_result is null or char_length(agent_result) <= 4000);

comment on column tasks.agent_instructions is
  'Tapas''s own words to his AI agents about this task, at most 2,000 characters. WRITTEN ONLY by his owner session (the guard_task_agent_instructions trigger refuses every other caller, service_role included). Never written by the mail scan or any tool.';
comment on column tasks.agent_instructions_at is
  'When the instruction last truly changed. Set by the guard trigger only, and only for his owner session.';
comment on column tasks.agent_status is
  'What the agents say about the current instruction: done or needs_you. Null means no result yet, and the trigger clears it when he changes the instruction. Written by the report_agent_result tool (service_role) or undo.';
comment on column tasks.agent_result is
  'The agents'' plain-text result, at most 4,000 characters. Stays visible until a newer result replaces it. Written by the report_agent_result tool.';
comment on column tasks.agent_result_at is
  'When agent_result was written.';
comment on column tasks.agent_done_hash is
  'sha256 of the exact agent_instructions text the last result answered, computed by the server. An instruction is pending while its hash differs from this.';

create or replace function public.guard_task_agent_instructions()
returns trigger
language plpgsql
as $$
declare
  is_owner boolean;
  old_text text;
  new_text text;
  text_changed boolean;
begin
  -- The owner session: the authenticated role, a JWT that says so, and a uid
  -- equal to the row's owner. service_role (connectors, crons, the scan) and
  -- a direct database session (no JWT, so no uid) all fail this.
  is_owner :=
    coalesce(auth.role(), '') = 'authenticated'
    and coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
    and auth.uid() is not null
    and auth.uid() = new.user_id;

  if tg_op = 'INSERT' then
    if new.agent_instructions is null and new.agent_instructions_at is null then
      return new;
    end if;
    if not is_owner then
      raise exception 'Only Tapas, from his own signed-in session, may write agent instructions.'
        using errcode = '42501';
    end if;
    new_text := nullif(btrim(new.agent_instructions), '');
    new.agent_instructions := new_text;
    new.agent_instructions_at := case when new_text is null then null else now() end;
    return new;
  end if;

  -- UPDATE. "Changed" is judged on the trimmed text with blank as null, so an
  -- ordinary drawer save that resends the same text changes nothing.
  old_text := nullif(btrim(old.agent_instructions), '');
  new_text := nullif(btrim(new.agent_instructions), '');
  text_changed := new_text is distinct from old_text;

  if (text_changed or new.agent_instructions_at is distinct from old.agent_instructions_at)
     and not is_owner then
    raise exception 'Only Tapas, from his own signed-in session, may write agent instructions.'
      using errcode = '42501';
  end if;

  if text_changed then
    -- A new instruction is pending again: stamp it and clear the status. The
    -- old result stays visible until a newer one replaces it.
    new.agent_instructions := new_text;
    new.agent_instructions_at := case when new_text is null then null else now() end;
    new.agent_status := null;
  else
    -- Nothing truly changed: keep the stored text and stamp exactly as they were.
    new.agent_instructions := old.agent_instructions;
    new.agent_instructions_at := old.agent_instructions_at;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_guard_agent_instructions on tasks;
create trigger tasks_guard_agent_instructions
  before insert or update on tasks
  for each row execute function public.guard_task_agent_instructions();
