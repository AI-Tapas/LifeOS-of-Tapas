// Kanban board ordering. Pure, so the board, the server action and the test
// all agree on what a drop means.

export const BOARD_STATUSES = ["inbox", "todo", "doing", "done"] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

export interface BoardCard {
  id: string;
  status: string;
  board_position?: number | null;
}

export interface PositionWrite {
  id: string;
  board_position: number;
}

// One column, top to bottom: cards never placed by hand first (in the order
// given, which is newest first), then his own order.
export function columnCards<T extends BoardCard>(tasks: T[], status: string): T[] {
  const col = tasks.filter((t) => t.status === status);
  const unplaced = col.filter((t) => t.board_position == null);
  const placed = col
    .filter((t) => t.board_position != null)
    .sort((a, b) => (a.board_position as number) - (b.board_position as number));
  return [...unplaced, ...placed];
}

// Drop card `id` into `status` at `index` (counted without the card itself).
// Returns the updated task list and only the positions that changed, or null
// when the drop changes nothing.
export function placeCard<T extends BoardCard>(
  tasks: T[],
  id: string,
  status: BoardStatus,
  index: number
): { tasks: T[]; writes: PositionWrite[] } | null {
  const card = tasks.find((t) => t.id === id);
  if (!card) return null;
  const col: T[] = columnCards(tasks, status).filter((t) => t.id !== id);
  const at = Math.max(0, Math.min(index, col.length));
  col.splice(at, 0, { ...card, status });
  // ponytail: renumbers the whole column 0..n, so one drop can write n rows.
  // Fine at a few hundred cards; switch to fractional positions if it drags.
  const next = col.map((t, k) => ({ ...t, board_position: k }));
  const before = new Map(tasks.map((t) => [t.id, t]));
  const changed = next.filter((t) => {
    const o = before.get(t.id)!;
    return o.board_position !== t.board_position || o.status !== t.status;
  });
  if (changed.length === 0) return null;
  const byId = new Map(next.map((t) => [t.id, t]));
  return {
    tasks: tasks.map((t) => byId.get(t.id) ?? t),
    writes: changed.map((t) => ({ id: t.id, board_position: t.board_position })),
  };
}
