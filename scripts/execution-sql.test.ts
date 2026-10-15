import test from "node:test";
import assert from "node:assert/strict";
import { sqlFixture, sqlRole } from "./helpers/sql-fixture.ts";
const owner = "00000000-0000-4000-8000-000000000001";

test("execution lifecycle retains claims and only marks a completed inverse undone", async (t) => {
  const { db, migrations } = await sqlFixture({ through: "20261015000100_execution_safety.sql" });
  t.diagnostic(`${migrations.length} actual migrations; isolated PostgreSQL with synthetic Supabase auth/Vault, serialized connections.`);
  try {
    await db.query("insert into auth.users values($1,$2)", [owner, "tapas.tnr@gmail.com"]);
    await sqlRole(db, "authenticated", owner);
    const { rows: [action] } = await db.query<{ id: string }>(
      "insert into assistant_actions(user_id,kind,mode,status,execution_state,executed_at) values($1,'add_note','auto','approved','running',now()) returning id", [owner]);
    await assert.rejects(db.query("update assistant_actions set payload='{\"changed\":true}' where id=$1", [action.id]), /payload is immutable/);
    await assert.rejects(db.query("update assistant_actions set executed_at=null where id=$1", [action.id]), /set exactly once/);
    await db.query("update assistant_actions set status='executed',execution_state='succeeded' where id=$1", [action.id]);
    await assert.rejects(db.query("update assistant_actions set status='undone',undone_at=now() where id=$1", [action.id]), /must be claimed/);
    const first = await db.query("update assistant_actions set undo_started_at=now() where id=$1 and status='executed' and undo_started_at is null returning id", [action.id]);
    const second = await db.query("update assistant_actions set undo_started_at=now() where id=$1 and status='executed' and undo_started_at is null returning id", [action.id]);
    assert.equal(first.rows.length, 1);
    assert.equal(second.rows.length, 0);
    // A known failed local inverse can release the claim without lying about completion.
    await db.query("update assistant_actions set undo_started_at=null,undo_error='Synthetic local failure' where id=$1", [action.id]);
    const retry = await db.query("update assistant_actions set undo_started_at=now(),undo_error=null where id=$1 and status='executed' and undo_started_at is null returning id", [action.id]);
    assert.equal(retry.rows.length, 1);
    await db.query("update assistant_actions set status='undone',undone_at=now(),undo_started_at=null where id=$1", [action.id]);
    await assert.rejects(db.query("update assistant_actions set status='executed' where id=$1", [action.id]), /invalid assistant action status transition/);
    const row = (await db.query<{ status: string; undo_started_at: string | null }>("select status,undo_started_at from assistant_actions where id=$1", [action.id])).rows[0];
    assert.equal(row.status, "undone");
    assert.equal(row.undo_started_at, null);
  } finally { await db.close(); }
});
