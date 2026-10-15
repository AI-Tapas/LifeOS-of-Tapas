-- B36: allow proposed -> saved_as_draft (owner chose Save to drafts), for a
-- send_email only. Same guard as before otherwise; saved_as_draft is terminal.
create or replace function public.guard_assistant_action_update()
returns trigger
language plpgsql
as $fn$
begin
  if old.status <> 'proposed' and new.payload is distinct from old.payload then
    raise exception 'assistant_actions.payload is immutable once status leaves proposed';
  end if;
  if new.kind is distinct from old.kind then
    raise exception 'assistant_actions.kind is immutable';
  end if;
  if old.executed_at is not null and new.executed_at is distinct from old.executed_at then
    raise exception 'assistant_actions.executed_at is set exactly once';
  end if;
  if new.status is distinct from old.status then
    if not (
      (old.status = 'proposed' and new.status in ('approved', 'rejected'))
      or (old.status = 'proposed' and new.status = 'saved_as_draft' and old.kind = 'send_email')
      or (old.status = 'approved' and new.status in ('executed', 'failed', 'rejected'))
      or (old.status = 'executed' and new.status = 'undone')
    ) then
      raise exception 'invalid assistant action status transition % -> %',
        old.status, new.status;
    end if;
  end if;
  return new;
end;
$fn$;
