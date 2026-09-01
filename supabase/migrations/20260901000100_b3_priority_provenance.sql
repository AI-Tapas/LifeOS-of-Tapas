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

create type priority_source as enum ('manual', 'assistant');

alter table tasks
  add column if not exists priority_source priority_source not null default 'manual',
  add column if not exists priority_reason text;

comment on column tasks.priority_source is
  'Whose judgment the current priority is. Assistant paths may never overwrite manual.';
comment on column tasks.priority_reason is
  'One short sentence of why the priority is what it is. Plain text, rendered as text, never markup.';
