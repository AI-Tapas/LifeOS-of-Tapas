// B36: the status guard lets a proposed email close as saved_as_draft, and no
// further. Runs the real migrations in an isolated PostgreSQL.
import test from "node:test";
import assert from "node:assert/strict";
import { sqlFixture, sqlRole } from "./helpers/sql-fixture.ts";
const owner = "00000000-0000-4000-8000-000000000001";

test("proposed -> saved_as_draft is allowed; saved_as_draft is terminal; approved cannot jump to it", async () => {
  const { db } = await sqlFixture();
  try {
    await db.query("insert into auth.users values($1,$2)", [owner, "tapas.tnr@gmail.com"]);
    await sqlRole(db, "authenticated", owner);
    const ins = (status: string) =>
      db.query<{ id: string }>("insert into assistant_actions(user_id,kind,mode,status) values($1,'send_email','draft',$2) returning id", [owner, status]);
    const { rows: [a] } = await ins("proposed");
    await db.query("update assistant_actions set status='saved_as_draft', result='{\"summary\":\"Saved to drafts in icai\"}' where id=$1", [a.id]);
    const row = (await db.query<{ status: string }>("select status from assistant_actions where id=$1", [a.id])).rows[0];
    assert.equal(row.status, "saved_as_draft");
    for (const to of ["proposed", "approved", "executed", "rejected"]) {
      await assert.rejects(db.query(`update assistant_actions set status='${to}' where id=$1`, [a.id]), /invalid assistant action status transition/);
    }
    const { rows: [t] } = await db.query<{ id: string }>("insert into assistant_actions(user_id,kind,mode,status) values($1,'propose_event_with_invites','draft','proposed') returning id", [owner]);
    await assert.rejects(db.query("update assistant_actions set status='saved_as_draft' where id=$1", [t.id]), /invalid assistant action status transition/);
    const { rows: [b] } = await ins("approved");
    await assert.rejects(db.query("update assistant_actions set status='saved_as_draft' where id=$1", [b.id]), /invalid assistant action status transition/);
  } finally { await db.close(); }
});
