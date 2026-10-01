// Proves the security model against the local Supabase stack:
//   1. the anon role can neither read nor write any table,
//   2. only the allow-listed email can get an auth.users row,
//   3. the owner sees exactly their seeded data.
// Run: supabase start, then npm run test:rls
import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const ALLOWED_EMAIL = "tapas.tnr@gmail.com";
const TABLES = [
  "accounts", "calendars", "events", "work_streams", "projects", "tasks",
  "trips", "trip_expenses", "people", "notes", "finance_items",
  "recurring_obligations", "reminders", "assistant_actions",
  "assistant_persona", "audit_log",
  // M4 and the connector: assistant_settings holds model choices, and the two
  // mcp_ tables hold OAuth registrations and hashed token material, so anon
  // must be shut out of them exactly as firmly.
  "assistant_settings", "mcp_clients", "mcp_grants",
  // M7c: the chat transcript is his own words about his own work, in the same
  // sensitivity class as assistant_persona. It was missing from this list.
  "assistant_chat_turns",
  // B22: the stored morning brief.
  "briefs",
];

function localEnv() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    return {
      url: process.env.SUPABASE_URL,
      anonKey: process.env.SUPABASE_ANON_KEY,
      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
  }
  const out = execSync("supabase status -o env", { encoding: "utf8" });
  const get = (name) => out.match(new RegExp(`${name}="?([^"\\r\\n]+)`))?.[1];
  return {
    url: get("API_URL"),
    anonKey: get("ANON_KEY"),
    serviceKey: get("SERVICE_ROLE_KEY"),
  };
}

const { url, anonKey, serviceKey } = localEnv();
assert.ok(url && anonKey && serviceKey, "supabase stack not running or keys missing");

const anon = createClient(url, anonKey, { auth: { persistSession: false } });
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

test("only the allow-listed email can be created", async () => {
  const { error } = await admin.auth.admin.createUser({
    email: "intruder@example.com",
    email_confirm: true,
  });
  assert.ok(error, "creating a non-allow-listed user must fail");
});

test("owner exists, is seeded, and can read own data", async () => {
  const created = await admin.auth.admin.createUser({
    email: ALLOWED_EMAIL,
    email_confirm: true,
  });
  if (created.error) {
    assert.match(created.error.message, /already/i);
  }

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: ALLOWED_EMAIL,
  });
  assert.ifError(linkError);

  const owner = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error: verifyError } = await owner.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  });
  assert.ifError(verifyError);

  const { data: streams, error } = await owner
    .from("work_streams")
    .select("name")
    .order("name");
  assert.ifError(error);
  assert.equal(streams.length, 7, "seed trigger must create 7 work streams");

  // owner can write and delete
  const ins = await owner.from("people").insert({ name: "RLS Probe" }).select().single();
  assert.ifError(ins.error);
  const del = await owner.from("people").delete().eq("id", ins.data.id);
  assert.ifError(del.error);

  // M2: the Vault decrypt path must never be reachable by the authenticated
  // browser role. The token functions are granted to service_role only.
  const denied = await owner.rpc("get_account_tokens", {
    p_account_id: "00000000-0000-0000-0000-000000000000",
  });
  assert.ok(denied.error, "authenticated must not execute get_account_tokens");

  // M4: audit_log is append-only for the browser role. The owner can insert
  // and read, but UPDATE and DELETE are revoked at the grant level.
  const auditIns = await owner
    .from("audit_log")
    .insert({ actor: "user", action: "rls_probe", entity: "tests" })
    .select()
    .single();
  assert.ifError(auditIns.error);
  const auditUpd = await owner
    .from("audit_log")
    .update({ action: "tampered" })
    .eq("id", auditIns.data.id)
    .select();
  assert.ok(
    auditUpd.error || (auditUpd.data ?? []).length === 0,
    "owner must not UPDATE audit_log rows"
  );
  const auditDel = await owner
    .from("audit_log")
    .delete()
    .eq("id", auditIns.data.id)
    .select();
  assert.ok(
    auditDel.error || (auditDel.data ?? []).length === 0,
    "owner must not DELETE audit_log rows"
  );
  await admin.from("audit_log").delete().eq("id", auditIns.data.id); // cleanup

  // M4: the assistant_actions guard trigger. Payload freezes once status
  // leaves proposed, and proposed can never jump straight to executed.
  const act = await owner
    .from("assistant_actions")
    .insert({ kind: "send_email", payload: { to: ["a@b.c"] }, title: "probe" })
    .select()
    .single();
  assert.ifError(act.error);
  const jump = await owner
    .from("assistant_actions")
    .update({ status: "executed" })
    .eq("id", act.data.id)
    .select();
  assert.ok(jump.error, "proposed -> executed must be refused by the trigger");
  const approve = await owner
    .from("assistant_actions")
    .update({ status: "approved", payload_hash: "x" })
    .eq("id", act.data.id)
    .select();
  assert.ifError(approve.error);
  const mutate = await owner
    .from("assistant_actions")
    .update({ payload: { to: ["attacker@evil.example"] } })
    .eq("id", act.data.id)
    .select();
  assert.ok(mutate.error, "payload must be immutable once status leaves proposed");
  await admin.from("assistant_actions").delete().eq("id", act.data.id); // cleanup
});

test("anon role cannot read any table", async () => {
  for (const table of TABLES) {
    const { data, error } = await anon.from(table).select("id").limit(1);
    assert.ok(
      error || (data && data.length === 0),
      `anon must not read rows from ${table}`
    );
  }
});

test("anon role cannot write any table", async () => {
  const probes = {
    work_streams: { name: "x", kind: "personal" },
    people: { name: "x" },
    tasks: { title: "x", work_stream_id: "00000000-0000-0000-0000-000000000000" },
  };
  for (const [table, row] of Object.entries(probes)) {
    const { error } = await anon.from(table).insert(row);
    assert.ok(error, `anon must not insert into ${table}`);
  }
});

// B26: only the owner's own signed-in session may write an agent instruction.
// service_role (connectors, crons, the scan) bypasses RLS, so this is proved
// against the guard_task_agent_instructions trigger, not against a policy.
// Needs the local stack with the B26 migration applied.
test("B26: agent instructions are writable by the owner session only", async () => {
  await admin.auth.admin.createUser({ email: ALLOWED_EMAIL, email_confirm: true });
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: ALLOWED_EMAIL,
  });
  assert.ifError(linkError);
  const owner = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data: session, error: verifyError } = await owner.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  });
  assert.ifError(verifyError);
  const ownerId = session.user.id;
  const { data: streams } = await owner.from("work_streams").select("id").limit(1);
  const stream = streams[0].id;

  // service_role cannot plant an instruction on insert.
  const planted = await admin
    .from("tasks")
    .insert({ user_id: ownerId, title: "B26 probe planted", work_stream_id: stream, agent_instructions: "do a thing" })
    .select("id");
  assert.ok(planted.error, "service_role must not insert an instruction");

  // A plain task from service_role is fine, and carries no instruction.
  const plain = await admin
    .from("tasks")
    .insert({ user_id: ownerId, title: "B26 probe plain", work_stream_id: stream })
    .select("id")
    .single();
  assert.ifError(plain.error);

  // service_role cannot change the instruction or its stamp on update.
  const svcText = await admin.from("tasks").update({ agent_instructions: "planted" }).eq("id", plain.data.id).select("id");
  assert.ok(svcText.error, "service_role must not set an instruction");
  const svcStamp = await admin
    .from("tasks")
    .update({ agent_instructions_at: new Date().toISOString() })
    .eq("id", plain.data.id)
    .select("id");
  assert.ok(svcStamp.error, "service_role must not set the instruction stamp");

  // The owner can write one; the trigger stamps it.
  const set = await owner
    .from("tasks")
    .update({ agent_instructions: "  Draft a reply to the client.  " })
    .eq("id", plain.data.id)
    .select("agent_instructions, agent_instructions_at, agent_status")
    .single();
  assert.ifError(set.error);
  assert.equal(set.data.agent_instructions, "Draft a reply to the client.");
  assert.ok(set.data.agent_instructions_at, "the trigger stamps the instruction time");

  // service_role records a result (allowed: not an instruction column).
  const rep = await admin
    .from("tasks")
    .update({ agent_status: "done", agent_result: "Drafted.", agent_result_at: new Date().toISOString() })
    .eq("id", plain.data.id)
    .select("agent_status")
    .single();
  assert.ifError(rep.error);
  assert.equal(rep.data.agent_status, "done");

  // An owner save that resends the same text leaves the status alone.
  const same = await owner
    .from("tasks")
    .update({ title: "B26 probe renamed", agent_instructions: "Draft a reply to the client." })
    .eq("id", plain.data.id)
    .select("agent_status, agent_instructions_at")
    .single();
  assert.ifError(same.error);
  assert.equal(same.data.agent_status, "done");
  assert.equal(same.data.agent_instructions_at, set.data.agent_instructions_at);

  // A truly new instruction clears the status.
  const changed = await owner
    .from("tasks")
    .update({ agent_instructions: "Draft a reply and copy the partner." })
    .eq("id", plain.data.id)
    .select("agent_status")
    .single();
  assert.ifError(changed.error);
  assert.equal(changed.data.agent_status, null);

  await admin.from("tasks").delete().eq("id", plain.data.id); // cleanup
});

// B30: only the owner's own signed-in session may mark work invoiced, clear a
// billing state, or change a task that is marked invoiced. service_role
// (connectors, crons) bypasses RLS, so this is proved against the
// guard_task_billing_state trigger. Needs the local stack with the B30
// migration applied. Not run for the build that added it.
test("B30: only the owner session may mark work invoiced or clear a billing state", async () => {
  await admin.auth.admin.createUser({ email: ALLOWED_EMAIL, email_confirm: true });
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: ALLOWED_EMAIL,
  });
  assert.ifError(linkError);
  const owner = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data: session, error: verifyError } = await owner.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  });
  assert.ifError(verifyError);
  const ownerId = session.user.id;
  const { data: streams } = await owner.from("work_streams").select("id").limit(1);
  const stream = streams[0].id;

  // service_role cannot insert an invoiced task.
  const planted = await admin
    .from("tasks")
    .insert({ user_id: ownerId, title: "B30 probe planted", work_stream_id: stream, billing_state: "invoiced" })
    .select("id");
  assert.ok(planted.error, "service_role must not insert an invoiced task");

  const plain = await admin
    .from("tasks")
    .insert({ user_id: ownerId, title: "B30 probe plain", work_stream_id: stream })
    .select("id")
    .single();
  assert.ifError(plain.error);

  // service_role cannot mark invoiced, but may draft an estimate and change it.
  const inv = await admin.from("tasks").update({ billing_state: "invoiced" }).eq("id", plain.data.id).select("id");
  assert.ok(inv.error, "service_role must not mark work invoiced");
  const est = await admin
    .from("tasks")
    .update({ billing_state: "estimate_drafted", billing_ref: "EST-1" })
    .eq("id", plain.data.id)
    .select("billing_state, billing_updated_at")
    .single();
  assert.ifError(est.error);
  assert.equal(est.data.billing_state, "estimate_drafted");
  assert.ok(est.data.billing_updated_at, "the trigger stamps the change");
  const nb = await admin.from("tasks").update({ billing_state: "not_billable" }).eq("id", plain.data.id).select("id");
  assert.ifError(nb.error);

  // service_role cannot clear a state.
  const clear = await admin.from("tasks").update({ billing_state: null }).eq("id", plain.data.id).select("id");
  assert.ok(clear.error, "service_role must not clear a billing state");

  // A reference over 40 characters is refused by the check constraint.
  const long = await admin.from("tasks").update({ billing_ref: "x".repeat(41) }).eq("id", plain.data.id).select("id");
  assert.ok(long.error, "a reference over 40 characters is refused");

  // The owner can mark it invoiced; then service_role cannot move it away.
  const own = await owner
    .from("tasks")
    .update({ billing_state: "invoiced", billing_ref: "INV-1" })
    .eq("id", plain.data.id)
    .select("billing_state")
    .single();
  assert.ifError(own.error);
  assert.equal(own.data.billing_state, "invoiced");
  const away = await admin.from("tasks").update({ billing_state: "not_billable" }).eq("id", plain.data.id).select("id");
  assert.ok(away.error, "service_role must not move a task away from invoiced");
  const ref = await admin.from("tasks").update({ billing_ref: "INV-2" }).eq("id", plain.data.id).select("id");
  assert.ok(ref.error, "service_role must not change the reference of an invoiced task");
  const other = await admin.from("tasks").update({ title: "B30 probe renamed" }).eq("id", plain.data.id).select("id");
  assert.ifError(other.error); // an ordinary write on an invoiced task is still fine

  // The owner can reopen it.
  const reopen = await owner.from("tasks").update({ billing_state: null }).eq("id", plain.data.id).select("billing_state").single();
  assert.ifError(reopen.error);
  assert.equal(reopen.data.billing_state, null);

  await admin.from("tasks").delete().eq("id", plain.data.id); // cleanup
});
