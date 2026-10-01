-- B30: unbilled work.
--
-- Tapas's worry: work he has finished is never invoiced. Life OS records which
-- finished client work has no invoice against it, and where its billing stands,
-- so a weekly list and his agents can chase it. It records STATE only: no
-- invoice, number, total or Zoho call (see "Billing" in CLAUDE.md, M6d).
--
-- Nullable or defaulted additions only, nothing backfilled, no stream seeded
-- as billable, RLS unchanged (new columns on existing tables).
--
-- NOT applied anywhere when it was written. Apply it before (or with) the
-- deploy of the B30 code: Settings, the Tasks page, /unbilled, the brief and
-- both connectors select these columns.

alter table work_streams
  add column if not exists billable boolean not null default false;

alter table tasks
  add column if not exists billable boolean,
  add column if not exists billing_state text,
  add column if not exists billing_ref text,
  add column if not exists billing_updated_at timestamptz;

alter table tasks
  add constraint tasks_billing_state_values
    check (billing_state is null or billing_state in ('estimate_drafted', 'invoiced', 'not_billable')),
  add constraint tasks_billing_ref_len
    check (billing_ref is null or char_length(billing_ref) <= 40);

comment on column work_streams.billable is
  'Ticked by Tapas in Settings for client streams whose finished tasks should be invoiced. Not seeded for any stream.';
comment on column tasks.billable is
  'Per-task override of work_streams.billable. Null means follow the stream; true or false overrides it. Recurring tasks and trip checklist steps are never billable work, whatever this says.';
comment on column tasks.billing_state is
  'Where the billing of this finished task stands: null (not yet), estimate_drafted (an agent prepared an unsent estimate), invoiced or not_billable. Only Tapas''s owner session may set invoiced, clear a state, or change a task away from invoiced (guard_task_billing_state).';
comment on column tasks.billing_ref is
  'The Zoho estimate or invoice number, at most 40 characters. A reference string only.';
comment on column tasks.billing_updated_at is
  'When billing_state or billing_ref last changed. Stamped by the guard trigger.';

-- Why a trigger: the connectors, crons and the scan reach the database as
-- service_role, which bypasses RLS, so leaving a value out of a tool schema is
-- not enough. Only Tapas may mark work invoiced; otherwise an agent could hide
-- unbilled work. Same caller test as guard_task_agent_instructions (B26).
create or replace function public.guard_task_billing_state()
returns trigger
language plpgsql
as $$
declare
  is_owner boolean;
begin
  is_owner :=
    coalesce(auth.role(), '') = 'authenticated'
    and coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
    and auth.uid() is not null
    and auth.uid() = new.user_id;

  if tg_op = 'INSERT' then
    if new.billing_state = 'invoiced' and not is_owner then
      raise exception 'Only Tapas, from his own signed-in session, may mark work invoiced.'
        using errcode = '42501';
    end if;
    if new.billing_state is not null or new.billing_ref is not null then
      new.billing_updated_at := now();
    end if;
    return new;
  end if;

  if new.billing_state is not distinct from old.billing_state
     and new.billing_ref is not distinct from old.billing_ref then
    -- Nothing about billing changed: keep the stamp exactly as it was.
    new.billing_updated_at := old.billing_updated_at;
    return new;
  end if;

  if not is_owner then
    if old.billing_state = 'invoiced' then
      raise exception 'Only Tapas, from his own signed-in session, may change a task that is marked invoiced.'
        using errcode = '42501';
    end if;
    if new.billing_state = 'invoiced' then
      raise exception 'Only Tapas, from his own signed-in session, may mark work invoiced.'
        using errcode = '42501';
    end if;
    if new.billing_state is null and old.billing_state is not null then
      raise exception 'Only Tapas, from his own signed-in session, may clear a billing state.'
        using errcode = '42501';
    end if;
  end if;

  new.billing_updated_at := now();
  return new;
end;
$$;

drop trigger if exists tasks_guard_billing_state on tasks;
create trigger tasks_guard_billing_state
  before insert or update on tasks
  for each row execute function public.guard_task_billing_state();
