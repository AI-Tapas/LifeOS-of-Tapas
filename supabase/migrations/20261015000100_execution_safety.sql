-- Durable intent and recoverable undo. Existing executed_at remains a once-only
-- execution claim; uncertainty never clears it or authorizes another send.
alter table public.assistant_actions
  add column execution_state text check (execution_state in ('running', 'succeeded', 'uncertain')),
  add column undo_started_at timestamptz,
  add column undo_error text;

comment on column public.assistant_actions.execution_state is
  'running includes crashed/unreconciled intent. Never retry an external effect solely because final history is absent.';
comment on column public.assistant_actions.undo_started_at is
  'CAS claim for an inverse. No automatic expiry: a crashed or uncertain provider inverse requires reconciliation before release.';

-- Preserve the existing payload, kind, execution timestamp and lifecycle guard.
-- The inverse now retains status executed while claimed and only transitions
-- to undone after success. No reversed lifecycle transition is needed.
create or replace function public.guard_assistant_action_undo()
returns trigger language plpgsql set search_path = public as $fn$
begin
  if new.status = 'undone' and old.status <> 'undone' then
    if old.undo_started_at is null or new.undone_at is null then
      raise exception 'Undo must be claimed and completed before marking undone';
    end if;
  end if;
  if new.undo_started_at is not null and new.status not in ('executed', 'undone') then
    raise exception 'Only executed actions can claim undo';
  end if;
  return new;
end;
$fn$;
create trigger guard_assistant_action_undo before update on public.assistant_actions
for each row execute function public.guard_assistant_action_undo();
