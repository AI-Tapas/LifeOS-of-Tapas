import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sqlFixture, sqlRole } from "./helpers/sql-fixture.ts";
import { hashSecret } from "../lib/mcp/oauth-core.ts";
const owner = "00000000-0000-4000-8000-000000000001";
const redirect = "https://client.example/cb";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const permissions = { read: true, write: false, mail_body: false, attachments: false, persona: false, finance: false, mailboxes: null, work_streams: null };

test("OAuth SQL lifecycle, rollback, scopes and service-only privileges", async (t) => {
  const { db, migrations } = await sqlFixture();
  t.diagnostic(`Applied ${migrations.length} migrations using isolated PostgreSQL ${(await db.query<{ server_version: string }>("show server_version")).rows[0].server_version}; synthetic Auth/Vault, serialized PGlite scheduling.`);
  await db.query("insert into auth.users values($1,$2)", [owner, "tapas.tnr@gmail.com"]);
  let counter = 0;
  const secret = () => hashSecret(`synthetic-${++counter}`);
  async function call(name: string, args: unknown[]) {
    assert(/^[a-z_]+$/.test(name));
    return (await db.query<{ result: { ok: boolean; error?: string } }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as result`, args)).rows[0].result;
  }
  async function connection() {
    const client = `client-${randomUUID()}`;
    await db.query("insert into mcp_clients(user_id,client_id,redirect_uris) values($1,$2,$3)", [owner, client, [redirect]]);
    return client;
  }
  async function approve(client: string, code = secret()) {
    assert.equal((await call("oauth_approve_client", [owner, client, redirect, challenge, code, JSON.stringify(permissions)])).ok, true);
    return code;
  }
  const exchange = (client: string, token: string, kind = "code", access = secret(), refresh = secret(), proof = challenge) => call("oauth_exchange_grant", [client, kind, token, redirect, proof, access, refresh]);
  try {
    await t.test("legacy, expired and disconnected clients fail closed; re-consent replaces credentials", async () => {
      const client = await connection();
      const old = secret();
      await db.query("insert into mcp_grants(user_id,client_id,kind,token_hash,expires_at) values($1,$2,'refresh',$3,now()+interval '1 hour')", [owner, client, old]);
      assert.equal((await exchange(client, old, "refresh")).ok, false);
      const code = await approve(client);
      assert.equal((await exchange(client, old, "refresh")).ok, false);
      assert.equal((await exchange(client, code)).ok, true);
      const expired = await connection();
      await db.query("update mcp_clients set registration_expires_at=now()-interval '1 second' where client_id=$1", [expired]);
      assert.equal((await call("oauth_approve_client", [owner, expired, redirect, challenge, secret(), JSON.stringify(permissions)])).ok, false);
    });
    await t.test("wrong PKCE and wrong client leave the code unused", async () => {
      const client = await connection(), other = await connection(), code = await approve(client);
      await approve(other);
      assert.equal((await exchange(client, code, "code", secret(), secret(), "wrong-proof")).ok, false);
      assert.equal((await exchange(other, code)).ok, false);
      assert.equal((await exchange(client, code)).ok, true);
    });
    await t.test("simultaneous submitted exchanges have one winner and replay revokes its family", async () => {
      const client = await connection(), code = await approve(client);
      const results = await Promise.all([exchange(client, code), exchange(client, code)]);
      assert.equal(results.filter((r) => r.ok).length, 1);
      const { rows } = await db.query<{ count: number }>("select count(*)::int as count from mcp_grants where client_id=$1 and revoked_at is null", [client]);
      assert.equal(rows[0].count, 0);
    });
    await t.test("refresh rotation detects replay and revokes all descendants", async () => {
      const client = await connection(), code = await approve(client), refresh = secret();
      assert.equal((await exchange(client, code, "code", secret(), refresh)).ok, true);
      const nextRefresh = secret();
      assert.equal((await exchange(client, refresh, "refresh", secret(), nextRefresh)).ok, true);
      assert.equal((await exchange(client, refresh, "refresh")).ok, false);
      assert.equal((await exchange(client, nextRefresh, "refresh")).ok, false);
    });
    await t.test("issuance failure rolls back code consumption", async () => {
      const client = await connection(), code = await approve(client);
      await assert.rejects(exchange(client, code, "code", code), /duplicate key/);
      assert.equal((await exchange(client, code)).ok, true);
    });
    await t.test("Disconnect tombstone blocks issuance after interleaved refresh; database errors roll back", async () => {
      const client = await connection(), code = await approve(client), refresh = secret();
      await exchange(client, code, "code", secret(), refresh);
      await db.exec("create function public.test_fail_disconnect() returns trigger language plpgsql as $$ begin if new.action='mcp_connection_revoked' then raise exception 'injected audit failure'; end if; return new; end $$; create trigger test_fail_disconnect before insert on audit_log for each row execute function public.test_fail_disconnect();");
      await assert.rejects(call("oauth_disconnect_client", [owner, client]), /injected audit failure/);
      assert.equal((await db.query<{ revoked_at: string | null }>("select revoked_at from mcp_clients where client_id=$1", [client])).rows[0].revoked_at, null);
      await db.exec("drop trigger test_fail_disconnect on audit_log; drop function public.test_fail_disconnect();");
      const rotated = secret();
      await Promise.all([exchange(client, refresh, "refresh", secret(), rotated), call("oauth_disconnect_client", [owner, client])]);
      assert.equal((await exchange(client, rotated, "refresh")).ok, false);
      assert.equal((await approveAfterDisconnect()).ok, false);
      async function approveAfterDisconnect() { return call("oauth_approve_client", [owner, client, redirect, challenge, secret(), JSON.stringify(permissions)]); }
    });
    await t.test("deleting a client cascades grants and revoking a refresh kills descendants", async () => {
      const client = await connection(), code = await approve(client), refresh = secret();
      await exchange(client, code, "code", secret(), refresh);
      assert.equal((await call("oauth_revoke_token", ["different-client", refresh])).ok, true);
      const next = secret();
      assert.equal((await exchange(client, refresh, "refresh", secret(), next)).ok, true);
      await call("oauth_revoke_token", [client, refresh]);
      assert.equal((await exchange(client, next, "refresh")).ok, false);
      await db.query("delete from mcp_clients where client_id=$1", [client]);
      assert.equal((await db.query<{ count: number }>("select count(*)::int as count from mcp_grants where client_id=$1", [client])).rows[0].count, 0);
    });
    await t.test("registration global quota and expiry cleanup are enforced in SQL", async () => {
      const other = randomUUID();
      // Reuse the real owner; age prior clients out of the hourly quota.
      await db.query("update mcp_clients set created_at=now()-interval '2 hours' where user_id=$1", [owner]);
      const expired = await connection();
      await db.query("update mcp_clients set created_at=now()-interval '2 days',registration_expires_at=now()-interval '1 day' where client_id=$1", [expired]);
      for (let i = 0; i < 30; i++) assert.equal((await call("oauth_register_client", [owner, `${other}-${i}`, "Test", [redirect]])).ok, true);
      assert.equal((await call("oauth_register_client", [owner, `${other}-overflow`, "Test", [redirect]])).error, "rate_limited");
      assert.equal((await db.query("select id from mcp_clients where client_id=$1", [expired])).rows.length, 0);
    });
    await t.test("anonymous and owner-session roles cannot invoke lifecycle RPCs", async () => {
      for (const role of ["anon", "authenticated"] as const) {
        await sqlRole(db, role, role === "authenticated" ? owner : undefined);
        for (const [name, args] of [
          ["oauth_register_client", [owner, "blocked", "Test", [redirect]]],
          ["oauth_approve_client", [owner, "blocked", redirect, challenge, secret(), JSON.stringify(permissions)]],
          ["oauth_exchange_grant", ["blocked", "code", secret(), redirect, challenge, secret(), secret()]],
          ["oauth_disconnect_client", [owner, "blocked"]],
          ["oauth_revoke_token", ["", secret()]],
        ] as [string, unknown[]][]) await assert.rejects(call(name, args), (error: unknown) => (error as { code?: string }).code === "42501");
      }
      await sqlRole(db, "service_role");
      assert.equal((await call("oauth_revoke_token", ["", secret()])).ok, true);
    });
  } finally { await db.close(); }
});
