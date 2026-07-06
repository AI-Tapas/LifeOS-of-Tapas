-- Life OS Milestone 1: full schema.
-- Conventions: snake_case identifiers, timestamptz in UTC, every table scoped
-- to the single owner via user_id with RLS. Confidential boundary: task
-- metadata, dates and reference links only; no document contents or uploads.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type account_provider as enum ('google', 'microsoft');
create type account_connect_mode as enum ('direct', 'forwarded');
create type event_source as enum ('synced', 'app', 'reminder');
create type work_stream_kind as enum (
  'training', 'consulting', 'tech_consulting', 'tax_advisory',
  'litigation', 'advisory', 'personal'
);
create type project_status as enum ('active', 'on_hold', 'done', 'dropped');
create type task_status as enum ('inbox', 'todo', 'doing', 'done', 'dropped');
create type task_priority as enum ('low', 'medium', 'high');
create type task_source as enum ('manual', 'email', 'assistant');
create type reminder_channel as enum ('gcal', 'in_app');
create type trip_purpose as enum ('aica', 'conference', 'leisure', 'other');
create type trip_status as enum ('planned', 'booked', 'done', 'cancelled');
create type trip_expense_category as enum ('transport', 'hotel', 'per_diem', 'other');
create type bill_recipient as enum ('institute', 'client', 'other');
create type bill_status as enum ('draft', 'sent', 'paid');
create type note_type as enum ('meeting', 'decision', 'idea', 'reference');
create type finance_item_kind as enum ('fd', 'mf', 'stock', 'ncd', 'other');
create type finance_key_date_type as enum ('maturity', 'review');
create type obligation_category as enum (
  'gas', 'electricity', 'credit_card', 'insurance', 'broadband',
  'rent', 'subscription', 'other'
);
create type obligation_frequency as enum (
  'monthly', 'bi_monthly', 'quarterly', 'half_yearly', 'yearly'
);
create type assistant_action_mode as enum ('auto', 'draft');
create type assistant_action_status as enum ('proposed', 'approved', 'executed', 'rejected');
create type assistant_persona_source as enum ('interview', 'seeded', 'edited');
create type audit_actor as enum ('user', 'assistant');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
-- FK on delete policy: cascade for containment (account -> calendars -> events,
-- trip -> expenses, task/finance_item/obligation -> reminders), set null for
-- loose links (tasks.project_id, bills.trip_id, notes.*), restrict for
-- work_stream references so a stream with history cannot vanish silently.

create table accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  provider account_provider not null,
  email text not null,
  label text,
  scopes text[] not null default '{}',
  -- Vault secret id; the token itself lives in vault.secrets, decrypted
  -- server-side only. Never exposed through any client API.
  refresh_token_enc uuid,
  calendar_sync boolean not null default false,
  mail_scan boolean not null default false,
  connect_mode account_connect_mode not null default 'direct',
  created_at timestamptz not null default now(),
  unique (user_id, provider, email)
);

create table calendars (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete cascade,
  ext_calendar_id text not null,
  name text not null,
  is_primary_write boolean not null default false,
  is_reminder_home boolean not null default false,
  color text,
  unique (account_id, ext_calendar_id)
);

create table events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  account_id uuid references accounts (id) on delete cascade,
  calendar_id uuid references calendars (id) on delete cascade,
  ext_event_id text,
  title text not null,
  description text,
  location text,
  start_ts timestamptz not null,
  end_ts timestamptz,
  all_day boolean not null default false,
  attendees jsonb,
  source event_source not null default 'app',
  updated_at timestamptz not null default now(),
  unique (calendar_id, ext_event_id)
);

create table work_streams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  kind work_stream_kind not null,
  billing_entity text,
  linked_account_hint text,
  feeds_billing boolean not null default false,
  active boolean not null default true,
  notes text,
  unique (user_id, name)
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  work_stream_id uuid not null references work_streams (id) on delete restrict,
  status project_status not null default 'active',
  notes text
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  notes text,
  status task_status not null default 'inbox',
  priority task_priority not null default 'medium',
  project_id uuid references projects (id) on delete set null,
  work_stream_id uuid not null references work_streams (id) on delete restrict,
  due_ts timestamptz,
  remind_offsets int[] not null default '{7,3,1,0}',
  recurring_rule text,
  source task_source not null default 'manual',
  external_ref text,
  is_billable boolean not null default false,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  purpose trip_purpose not null,
  title text not null,
  work_stream_id uuid not null references work_streams (id) on delete restrict,
  start_date date,
  end_date date,
  cities jsonb,
  legs jsonb,
  status trip_status not null default 'planned',
  billable_to text,
  notes text
);

create table trip_expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  trip_id uuid not null references trips (id) on delete cascade,
  category trip_expense_category not null,
  amount numeric(14,2) not null,
  date date not null,
  billable boolean not null default false,
  -- reference string (folder path, mail subject), never an uploaded file
  receipt_ref text
);

create table bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  trip_id uuid references trips (id) on delete set null,
  work_stream_id uuid not null references work_streams (id) on delete restrict,
  bill_to bill_recipient not null,
  number text not null,
  date date not null,
  line_items jsonb not null default '[]',
  amount numeric(14,2) not null,
  status bill_status not null default 'draft',
  pdf_ref text,
  unique (user_id, number)
);

create table people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  org text,
  role text,
  emails text[] not null default '{}',
  phones text[] not null default '{}',
  context_md text,
  last_interaction timestamptz
);

create table notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  type note_type not null,
  title text not null,
  body_md text,
  occurred_on date,
  people_ids uuid[] not null default '{}',
  project_id uuid references projects (id) on delete set null,
  work_stream_id uuid references work_streams (id) on delete set null,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table finance_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind finance_item_kind not null,
  name text not null,
  institution text,
  principal_or_units numeric(18,4),
  value numeric(14,2),
  key_date date,
  key_date_type finance_key_date_type,
  remind boolean not null default true,
  notes text
);

create table recurring_obligations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  category obligation_category not null,
  amount numeric(14,2),
  variable_amount boolean not null default false,
  frequency obligation_frequency not null,
  due_day int check (due_day between 1 and 31),
  due_month int check (due_month between 1 and 12),
  remind_offsets int[] not null default '{7,3,1,0}',
  autopay boolean not null default false,
  account_ref text,
  active boolean not null default true,
  notes text
);

create table reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  task_id uuid references tasks (id) on delete cascade,
  finance_item_id uuid references finance_items (id) on delete cascade,
  obligation_id uuid references recurring_obligations (id) on delete cascade,
  remind_ts timestamptz not null,
  ext_event_id text,
  channel reminder_channel not null default 'in_app',
  created boolean not null default false,
  -- a reminder belongs to exactly one parent
  check (num_nonnulls(task_id, finance_item_id, obligation_id) = 1)
);

create table assistant_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}',
  -- mode 'auto' still requires status to pass through 'approved' before
  -- 'executed'; explicit user confirmation is enforced in later milestones
  mode assistant_action_mode not null default 'draft',
  status assistant_action_status not null default 'proposed',
  created_at timestamptz not null default now()
);

create table assistant_persona (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  version int not null default 1,
  sections_md text not null default '',
  source assistant_persona_source not null,
  inferred_items jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  actor audit_actor not null,
  action text not null,
  entity text not null,
  entity_id uuid,
  meta jsonb not null default '{}',
  ts timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes on lookup columns
-- ---------------------------------------------------------------------------
create index calendars_account_id_idx on calendars (account_id);
create index events_calendar_id_idx on events (calendar_id);
create index events_start_ts_idx on events (start_ts);
create index projects_work_stream_id_idx on projects (work_stream_id);
create index projects_status_idx on projects (status);
create index tasks_work_stream_id_idx on tasks (work_stream_id);
create index tasks_project_id_idx on tasks (project_id);
create index tasks_status_idx on tasks (status);
create index tasks_due_ts_idx on tasks (due_ts);
create index reminders_task_id_idx on reminders (task_id);
create index reminders_remind_ts_idx on reminders (remind_ts);
create index trips_work_stream_id_idx on trips (work_stream_id);
create index trip_expenses_trip_id_idx on trip_expenses (trip_id);
create index bills_work_stream_id_idx on bills (work_stream_id);
create index bills_status_idx on bills (status);
create index notes_project_id_idx on notes (project_id);
create index notes_work_stream_id_idx on notes (work_stream_id);
create index finance_items_key_date_idx on finance_items (key_date);
create index audit_log_ts_idx on audit_log (ts);
create index audit_log_entity_idx on audit_log (entity, entity_id);

-- ---------------------------------------------------------------------------
-- Row level security: owner-only on every table
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'calendars', 'events', 'work_streams', 'projects', 'tasks',
    'trips', 'trip_expenses', 'bills', 'people', 'notes', 'finance_items',
    'recurring_obligations', 'reminders', 'assistant_actions',
    'assistant_persona', 'audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy owner_all on public.%I for all to authenticated '
      || 'using (user_id = (select auth.uid())) '
      || 'with check (user_id = (select auth.uid()))', t);
  end loop;
end
$$;
