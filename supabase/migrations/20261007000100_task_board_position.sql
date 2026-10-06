-- Kanban board: his own order of cards inside a board column.
-- Null means never placed by hand; those cards sit at the top of their
-- column, newest first, so a fresh capture is never buried. Any status change
-- clears it (lib/tasks/write.ts), so a card lands on top of its new column
-- until he places it.
alter table tasks add column if not exists board_position integer;

comment on column tasks.board_position is
  'Order inside its board column, 0 at the top. Null: not placed by hand.';
