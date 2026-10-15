import test from "node:test";
import assert from "node:assert/strict";
import { sqlFixture, sqlRole } from "./helpers/sql-fixture.ts";
const OWNER = "00000000-0000-4000-8000-000000000010";
test("MCP SQL reservations, scoped jobs and versioned preview transactions", async () => {
  const { db } = await sqlFixture();
  try {
    await db.query("insert into auth.users(id,email) values($1,'tapas.tnr@gmail.com')", [OWNER]);
    await sqlRole(db, "service_role", OWNER);
    const rpc = async (action: string, args: Record<string, unknown> = {}, client = "client-a") => {
      const r = await db.query<{result: Record<string, unknown>}>("select mcp_service($1,$2,$3,$4::jsonb) result", [action, OWNER, client, JSON.stringify(args)]);
      return r.rows[0].result;
    };
    const a = await rpc("reserve", { key: "same", hash: "h", scope_hash: "scope", tool: "lifeos_add_note" });
    assert.equal(a.claimed, true);
    const b = await rpc("reserve", { key: "same", hash: "h", scope_hash: "scope", tool: "lifeos_add_note" });
    assert.equal(b.claimed, false);
    assert.equal((a.operation as {id:string}).id, (b.operation as {id:string}).id);
    const other = await rpc("operation", { id: (a.operation as {id:string}).id }, "client-b");
    assert.equal(other.error, "not_found");
    const note = await db.query<{id:string}>("insert into notes(user_id,type,title,body_md) values($1,'idea','Before','old') returning id", [OWNER]);
    const recordId = note.rows[0].id;
    const unsupported = await rpc("preview", { table: "notes", id: recordId, patch: {user_id: OWNER} });
    assert.equal(unsupported.error,"unsupported_field");
    const preview = await rpc("preview", { table: "notes", id: recordId, patch: {title:"After"} });
    assert.ok(preview.preview_id);
    assert.equal((await rpc("preview", {table:"notes",id:recordId,patch:{title:"Scoped"},work_streams:[]})).error,"permission_denied");
    assert.equal((await rpc("commit_preview", {id:preview.preview_id,work_streams:[]})).error,"permission_denied");
    assert.equal((await rpc("commit_preview", {id:preview.preview_id}, "client-b")).error,"not_found");
    await db.query("update notes set body_md='new concurrent content' where id=$1", [recordId]);
    assert.equal((await rpc("commit_preview", {id:preview.preview_id})).error,"version_conflict");
    const next = await rpc("preview", { table: "notes", id: recordId, patch: {title:"After"} });
    const committed = await rpc("commit_preview", {id:next.preview_id});
    assert.equal(committed.state,"completed"); assert.equal(committed.undo_available,true);
    assert.deepEqual(await rpc("commit_preview", {id:next.preview_id}), committed);
    const history = await db.query<{title:string;execution_state:string;result:{undo:{prev:{title:string}}}}>("select title,execution_state,result from assistant_actions where id=$1",[committed.action_id]);
    assert.equal(history.rows[0].execution_state,"succeeded"); assert.equal(history.rows[0].result.undo.prev.title,"Before");
    const job = await rpc("start_job", { input:{days:1}, capabilities:{} });
    assert.equal(job.state,"queued");
    assert.equal((await rpc("start_job", { input:{days:1}, capabilities:{} })).error,"job_busy");
    assert.equal((await rpc("job", { id:job.id },"client-b")).error,"not_found");
    assert.equal((await rpc("cancel_job", {id:job.id})).state,"cancelled");
    assert.equal(await rpc("claim_job"),null);
    const fresh = await rpc("start_job", { input:{days:1}, capabilities:{} });
    assert.equal((await rpc("claim_job")).id,fresh.id);
    assert.equal(await rpc("claim_job"),null);
    await db.query("update mcp_jobs set started_at=now()-interval '11 minutes' where id=$1",[fresh.id]);
    assert.equal(await rpc("claim_job"),null);
    assert.equal((await rpc("job",{id:fresh.id})).state,"uncertain");
    // Retention: finished operations older than 30 days go, recent/running/uncertain stay.
    await db.exec("reset role");
    await db.query("insert into mcp_operations(user_id,client_id,idempotency_key,request_hash,tool,scope_hash,state,updated_at) values($1,'client-a','old-done','h','t','s','completed',now()-interval '31 days'),($1,'client-a','old-failed','h','t','s','failed',now()-interval '31 days'),($1,'client-a','old-uncertain','h','t','s','uncertain',now()-interval '31 days'),($1,'client-a','new-done','h','t','s','completed',now())",[OWNER]);
    await sqlRole(db,"service_role",OWNER);
    await rpc("begin_call",{tool:"lifeos_list_tasks"});
    await db.exec("reset role");
    const kept = (await db.query<{idempotency_key:string}>("select idempotency_key from mcp_operations where idempotency_key in ('old-done','old-failed','old-uncertain','new-done') order by 1")).rows.map(r=>r.idempotency_key);
    assert.deepEqual(kept,["new-done","old-uncertain"]);
    // Rate limit: 240 calls a minute per client, then refused.
    await db.query("insert into mcp_activity(user_id,client_id,tool) select $1,'client-rl','t' from generate_series(1,239)",[OWNER]);
    await sqlRole(db,"service_role",OWNER);
    assert.ok((await rpc("begin_call",{tool:"t"},"client-rl")).id, "call 240 is allowed");
    assert.equal((await rpc("begin_call",{tool:"t"},"client-rl")).error,"rate_limited");
    await sqlRole(db,"authenticated",OWNER);
    await assert.rejects(() => db.query("select mcp_service('reserve',$1,'client-a','{}')",[OWNER]),/permission denied/);
    await assert.rejects(() => db.query("update mcp_jobs set state='completed'"),/permission denied/);
  } finally { await db.close(); }
});
