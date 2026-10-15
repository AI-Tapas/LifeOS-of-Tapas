import test from "node:test";
import assert from "node:assert/strict";
import { sqlFixture, sqlRole } from "./helpers/sql-fixture.ts";
const OWNER = "00000000-0000-4000-8000-000000000010";
const OTHER = "00000000-0000-4000-8000-000000000011";
test("shared scan execution SQL claims fence every entrypoint and require owner authorization", async () => {
  const { db } = await sqlFixture();
  try {
    await db.query("insert into auth.users(id,email) values($1,'tapas.tnr@gmail.com')", [OWNER]);
    const claim = async (owner = OWNER) => (await db.query<{value:{claimed:boolean;run_id:string;status:string}}>(
      "select claim_scan_execution($1) value",[owner])).rows[0].value;
    const release = async (runId:string, owner = OWNER) => (await db.query<{value:boolean}>(
      "select release_scan_execution($1,$2) value",[owner,runId])).rows[0].value;
    await sqlRole(db,"authenticated",OWNER);
    const ownerScan = await claim();
    assert.equal(ownerScan.claimed,true);
    await sqlRole(db,"service_role",OWNER);
    assert.equal((await claim()).claimed,false,"a scheduled/API scan cannot overlap an owner scan");
    await sqlRole(db,"authenticated",OTHER);
    await assert.rejects(()=>claim(),/Owner authorization required/);
    await assert.rejects(()=>release(ownerScan.run_id),/Owner authorization required/);
    assert.equal((await db.query("select * from scan_execution")).rows.length,0);
    await sqlRole(db,"authenticated",OWNER);
    assert.equal(await release(ownerScan.run_id),true);
    const retry = await claim();
    assert.equal(retry.claimed,true); assert.notEqual(retry.run_id,ownerScan.run_id);
    assert.equal(await release(ownerScan.run_id),false,"old worker cannot release a newer claim");
    await assert.rejects(()=>db.query("update scan_execution set status='released'"),/permission denied/);
    await db.exec("reset role");
    await db.query("update scan_execution set started_at=now()-interval '11 minutes' where user_id=$1",[OWNER]);
    await sqlRole(db,"service_role",OWNER);
    const interrupted = await claim();
    assert.equal(interrupted.claimed,false); assert.equal(interrupted.status,"uncertain");
    assert.equal(await release(retry.run_id),false,"uncertain run requires explicit reconciliation");
    assert.equal((await claim()).claimed,false,"a claim under 2 hours old is never taken over");
    // Stale uncertain claim: taken over after 2 hours, with an audit row.
    await db.exec("reset role");
    await db.query("update scan_execution set started_at=now()-interval '3 hours' where user_id=$1",[OWNER]);
    await sqlRole(db,"service_role",OWNER);
    const takeover = await claim();
    assert.equal(takeover.claimed,true); assert.notEqual(takeover.run_id,retry.run_id);
    assert.equal(await release(retry.run_id),false,"the old worker cannot release the new claim");
    await db.exec("reset role");
    const audit = (await db.query<{meta:{previous_status:string;reason:string}}>("select meta from audit_log where action='scan_claim_taken_over'")).rows;
    assert.equal(audit.length,1); assert.equal(audit[0].meta.previous_status,"uncertain"); assert.equal(audit[0].meta.reason,"stale_scan_claim");
    // Stale running claim (never marked uncertain) is also taken over.
    await db.query("update scan_execution set started_at=now()-interval '3 hours' where user_id=$1",[OWNER]);
    await sqlRole(db,"service_role",OWNER);
    assert.equal((await claim()).claimed,true);
    await db.exec("reset role");
    assert.equal((await db.query("select 1 from audit_log where action='scan_claim_taken_over' and meta->>'previous_status'='running'")).rows.length,1);
    await sqlRole(db,"service_role",OWNER);
    await sqlRole(db,"anon");
    await assert.rejects(()=>claim(),/permission denied/);
    await assert.rejects(()=>release(retry.run_id),/permission denied/);
  } finally { await db.close(); }
});
