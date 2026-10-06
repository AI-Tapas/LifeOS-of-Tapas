// Kanban board ordering. Run: npm run test:board

import test from "node:test";
import assert from "node:assert/strict";
import { columnCards, placeCard, type BoardCard } from "../lib/tasks/board.ts";

const t = (id: string, status: string, board_position: number | null = null): BoardCard => ({
  id,
  status,
  board_position,
});
const ids = (cards: BoardCard[]) => cards.map((c) => c.id);

test("unplaced cards sit on top, placed ones follow his order", () => {
  const tasks = [t("a", "todo", 1), t("new", "todo"), t("b", "todo", 0), t("x", "doing")];
  assert.deepEqual(ids(columnCards(tasks, "todo")), ["new", "b", "a"]);
});

test("reorder inside a column writes only what moved", () => {
  const tasks = [t("a", "todo", 0), t("b", "todo", 1), t("c", "todo", 2)];
  const r = placeCard(tasks, "c", "todo", 0)!;
  assert.deepEqual(ids(columnCards(r.tasks, "todo")), ["c", "a", "b"]);
  assert.deepEqual(r.writes, [
    { id: "c", board_position: 0 },
    { id: "a", board_position: 1 },
    { id: "b", board_position: 2 },
  ]);
});

test("moving to another column changes status and slots it in", () => {
  const tasks = [t("a", "todo", 0), t("d1", "doing", 0), t("d2", "doing", 1)];
  const r = placeCard(tasks, "a", "doing", 1)!;
  assert.deepEqual(ids(columnCards(r.tasks, "doing")), ["d1", "a", "d2"]);
  assert.deepEqual(columnCards(r.tasks, "todo"), []);
  assert.deepEqual(r.writes, [
    { id: "a", board_position: 1 },
    { id: "d2", board_position: 2 },
  ]);
});

test("dropping a card where it already is does nothing", () => {
  const tasks = [t("a", "todo", 0), t("b", "todo", 1)];
  assert.equal(placeCard(tasks, "b", "todo", 1), null);
  assert.equal(placeCard(tasks, "missing", "todo", 0), null);
});

test("an out-of-range index clamps to the ends", () => {
  const tasks = [t("a", "todo", 0), t("b", "todo", 1)];
  assert.deepEqual(ids(columnCards(placeCard(tasks, "a", "todo", 99)!.tasks, "todo")), ["b", "a"]);
  assert.deepEqual(ids(columnCards(placeCard(tasks, "b", "todo", -5)!.tasks, "todo")), ["b", "a"]);
});
