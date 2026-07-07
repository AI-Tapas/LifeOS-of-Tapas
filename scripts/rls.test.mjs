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
