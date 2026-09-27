-- B20: mail scanner quality.
--
-- Tapas reviewed the 27 September 2026 brief and named five faults in what
-- the 3 AM mail scan files. Three of the fixes need somewhere to keep a fact,
-- and all three are nullable additions: nothing existing changes meaning,
-- nothing is backfilled, and RLS is unchanged (a new column on an existing
-- table inherits its policies).
--
-- NOT applied anywhere when it was written. Apply it before (or with) the
-- deploy of the B20 code: the scan and the brief select these columns.

-- 1. Fewer repeats. The provider's thread id (Gmail threadId, Graph
-- conversationId) of the mail a task came from, so a resent email or a chaser
-- on the same thread is dropped before the model sees it.
alter table tasks
  add column if not exists external_thread text;

comment on column tasks.external_thread is
  'Provider thread id (Gmail threadId, Graph conversationId) of the mail a scanned task came from. An id, never mail text.';

-- The "sent twice" case across threads: a sha256 of the sender address and
-- the normalised subject (Re:/Fwd: stripped, lower case). A hash, so the
-- subject text itself is never stored.
alter table tasks
  add column if not exists source_key text;

comment on column tasks.source_key is
  'sha256 hex of sender address and normalised subject of the mail a scanned task came from. Never the subject itself.';

create index if not exists tasks_external_thread_idx
  on tasks (user_id, external_thread) where external_thread is not null;
create index if not exists tasks_source_key_idx
  on tasks (user_id, source_key) where source_key is not null;

-- 2. Closed windows lapse. The IST date after which an opportunity or window
-- is simply gone: an early-bird price, an RSVP, an e-vote, an event day, a
-- "before 3 PM today" authorisation. The 7 AM brief moves an open task whose
-- lapses_on is before today to dropped (undoable). NEVER used for a
-- statutory, client or payment deadline: those stay open and overdue until
-- he decides. Existing tasks are left alone; nothing is backfilled.
alter table tasks
  add column if not exists lapses_on date;

comment on column tasks.lapses_on is
  'IST date after which this opportunity or window is gone (early bird, RSVP, e-vote, event day). The morning sweep drops it after this date. Never a statutory, client or payment deadline.';

-- 3. Better work streams. One short line per stream saying what belongs in
-- it, handed to the mail scan beside the stream name. Edited in Settings,
-- 200 characters at most.
alter table work_streams
  add column if not exists scan_hint text;

alter table work_streams
  drop constraint if exists work_streams_scan_hint_len;
alter table work_streams
  add constraint work_streams_scan_hint_len check (
    scan_hint is null or char_length(scan_hint) <= 200
  );

comment on column work_streams.scan_hint is
  'What mail belongs in this stream, for the mail scan. Plain text, at most 200 characters.';

-- Seed hints by stream name, only where the stream exists and has no hint
-- yet, so a hint he has already written is never overwritten and a missing
-- stream is simply skipped. Names as they are in Life OS (confirmed by the
-- orchestrator on 27 September 2026). Health deliberately gets no hint.
update work_streams set scan_hint =
  'GST work for clients: registrations, returns, ledger or balance confirmations, notices, refunds, litigation.'
where name = 'Tax Strategia' and scan_hint is null;

update work_streams set scan_hint =
  'AI and automation consulting and solution projects, proposals, workflows; apps Tapas built and maintains for clients, and their cloud bills or alerts (e.g. a realty app on AWS).'
where name = 'Individual consulting' and scan_hint is null;

update work_streams set scan_hint =
  'ICAI and AICA faculty sessions, schedules, travel, panels, feedback, invoices to ICAI.'
where name = 'ICAI' and scan_hint is null;

update work_streams set scan_hint =
  'Tapas''s own life only: family, home, health, personal purchases. Never client or professional work.'
where name = 'Personal' and scan_hint is null;

update work_streams set scan_hint =
  'Altechon as a brand itself, and its own Microsoft and Azure subscriptions and bills. Client work arriving in the Altechon mailbox goes to its topic''s stream.'
where name = 'Altechon' and scan_hint is null;

update work_streams set scan_hint =
  'Cygnet client work: proof of concept and prompts for Cygnet''s own systems.'
where name = 'Cygnet' and scan_hint is null;

update work_streams set scan_hint =
  'Training programmes Tapas delivers outside ICAI.'
where name = 'Individual training' and scan_hint is null;
