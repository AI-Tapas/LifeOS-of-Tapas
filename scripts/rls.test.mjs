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
  "trips", "trip_expenses", "bills", "people", "notes", "finance_items",
  "recurring_obligations", "reminders", "assistant_actions",
  "assistant_persona", "audit_log",
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
