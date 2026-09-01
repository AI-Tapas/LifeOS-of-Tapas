-- B3: the assistant may propose a priority, and say why.
--
-- The problem: Home ranks urgent-and-important first, then important, then
-- urgent. Importance is tasks.priority, set by hand. Tapas has never set it,
-- so all fifty live tasks sit at 'medium' and the "Do first" band ranks on
-- the clock alone, which is exactly the method he named as his problem. The
-- ranking is sound and its input is empty.
--
-- Two columns fill it without taking the judgment away from him.
--
-- priority_source records whose judgment the current priority is. It defaults
-- to 'manual', so every row that already exists counts as his, and the rule
-- enforced in lib/tasks/write.ts is that no assistant path may ever overwrite
-- a 'manual' priority, in either direction. He corrects it once and it stays
-- corrected.
--
-- priority_reason carries one short sentence of why. An assistant priority
-- with no reason is refused by the write layer, because the reason is the
-- whole point: it is what lets him disagree.
--
-- No tool schema exposes priority_source. Only the app's own forms set
-- 'manual' (scripts/b3.test.ts proves both).

-- Three values, not two. 'unset' is the honest state of a task nobody has
-- judged yet, and it is what every existing row backfills to below.
--
-- Two values would have deadlocked this feature on day one: defaulting the
-- existing fifty rows to 'manual' counts them as Tapas's own judgment, and
-- the never-overwrite rule then refuses every one of them, so the "review my
-- priorities" pass this milestone exists for would have been rejected fifty
-- times over. Only 'manual' is protected. 'unset' and 'assistant' are both
-- writable by an assistant path.
create type priority_source as enum ('unset', 'manual', 'assistant');

alter table tasks
  add column if not exists priority_source priority_source not null default 'unset',
  add column if not exists priority_reason text;

-- Backfill: a row still on the default 'medium' has never been rated by
-- anyone, so it stays 'unset' and the assistant may propose for it. A row he
-- had already moved to high or low IS his judgment, and is locked as such.
update tasks
set priority_source = 'manual'
where priority <> 'medium';

comment on column tasks.priority_source is
  'Whose judgment the current priority is: unset (nobody yet), manual (Tapas, never overwritten by any assistant path), assistant.';
comment on column tasks.priority_reason is
  'One short sentence of why the priority is what it is. Plain text, rendered as text, never markup.';
