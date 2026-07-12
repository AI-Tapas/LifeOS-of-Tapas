-- Life OS Milestone 3: calendar event sync, tasks/reminders logic.
--
-- M1 already shipped the events, tasks, projects, reminders and
-- recurring_obligations tables with the shapes M3 needs, so this migration is
-- deliberately small. It only adds the per-calendar sync state the read path
-- needs (which calendars to sync, the provider sync cursor, and when each was
-- last synced) plus a couple of lookup indexes. No new tables, no shape changes
-- to events/tasks/reminders. RLS is inherited from the M1 owner_all policies.

-- ---------------------------------------------------------------------------
-- calendars: per-calendar sync selection and incremental-sync cursor
-- ---------------------------------------------------------------------------
alter table calendars
  -- Which calendars the unified view syncs. Default true: a newly discovered
  -- calendar is synced until the user turns it off in Settings.
  add column sync_enabled boolean not null default true,
  -- Provider incremental-sync cursor. Google: nextSyncToken. Microsoft Graph:
  -- the delta link (a full URL). Null means the next sync runs a full window.
  add column sync_token text,
  add column last_synced_at timestamptz;

-- ---------------------------------------------------------------------------
-- Lookup indexes for the calendar window query and the reminder retry sweep
-- ---------------------------------------------------------------------------
-- The calendar UI reads events for the signed-in user within a time window.
create index if not exists events_user_start_idx on events (user_id, start_ts);
-- The retry sweep looks for reminders that were not created on Google yet.
create index if not exists reminders_created_idx on reminders (created)
  where created = false;
