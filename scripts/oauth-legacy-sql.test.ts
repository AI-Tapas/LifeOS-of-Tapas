import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sqlFixture } from "./helpers/sql-fixture.ts";
import { hashSecret } from "../lib/mcp/oauth-core.ts";
const owner = "00000000-0000-4000-8000-000000000001";
const sha = (n: string) => hashSecret(`legacy-${n}`);

test("OAuth migration keeps live connections working and revokes the rest", async () => {
  // State before the OAuth security migration, as production has it today.
  const { db } = await sqlFixture({ through: "20261015000100_execution_safety.sql" });
  try {
    await db.query("insert into auth.users(id,email) values($1,'tapas.tnr@gmail.com')", [owner]);
    for (const c of ["live", "dead", "expired"]) {
      await db.query("insert into mcp_clients(user_id,client_id,redirect_uris) values($1,$2,'{https://c.example/cb}')", [owner, c]);
    }
    const grant = (client: string, kind: string, name: string, interval: string, revoked = false) => db.query(
      `insert into mcp_grants(user_id,client_id,kind,token_hash,expires_at,revoked_at) values($1,$2,$3,$4,now()+interval '${interval}',${revoked ? "now()" : "null"})`,
      [owner, client, kind, sha(name)]);
    await grant("live", "access", "live-access", "1 hour");
    await grant("live", "refresh", "live-refresh", "30 days");
    await grant("live", "code", "live-code", "4 minutes");
    await grant("dead", "refresh", "dead-refresh", "30 days", true); // revoked
    await grant("expired", "access", "expired-access", "-1 hour"); // expired
    await db.exec(readFileSync(new URL("../supabase/migrations/20261015000200_oauth_security.sql", import.meta.url), "utf8"));

    const clients = Object.fromEntries((await db.query<{ client_id: string; approved_at: string | null; caps: Record<string, unknown> | null; far: boolean }>(
      "select client_id,approved_at,capabilities caps,registration_expires_at>now()+interval '1000 days' far from mcp_clients")).rows.map(r => [r.client_id, r]));
    assert.ok(clients.live.approved_at, "live client approved");
    assert.equal(clients.live.far, true, "no registration expiry");
    assert.deepEqual(clients.live.caps, { read: true, write: true, mail_body: true, attachments: true, persona: true, finance: true, mailboxes: null, work_streams: null });
    assert.equal(clients.dead.approved_at, null); assert.equal(clients.expired.approved_at, null);

    const live = (await db.query<{ kind: string; live: boolean }>("select kind,(revoked_at is null) live from mcp_grants where client_id='live'")).rows;
    assert.equal(live.find(g => g.kind === "access")?.live, true);
    assert.equal(live.find(g => g.kind === "refresh")?.live, true);
    assert.equal(live.find(g => g.kind === "code")?.live, false, "in-flight codes are revoked");
    assert.equal((await db.query("select 1 from mcp_grants where client_id in ('dead','expired') and revoked_at is null")).rows.length, 0);
    assert.equal((await db.query("select 1 from audit_log where action='mcp_connection_kept_on_migration'")).rows.length, 1);

    // The legacy refresh token still rotates; replaying it afterwards revokes the family.
    const rotate = async (token: string, a: string, r: string) => (await db.query<{ v: { ok: boolean } }>(
      "select oauth_exchange_grant('live','refresh',$1,null,null,$2,$3) v", [token, sha(a), sha(r)])).rows[0].v;
    assert.equal((await rotate(sha("live-refresh"), "a2", "r2")).ok, true, "legacy refresh works without re-consent");
    assert.equal((await rotate(sha("live-refresh"), "a3", "r3")).ok, false, "replay is refused");
    assert.equal((await rotate(sha("r2"), "a4", "r4")).ok, false, "replay revoked the new family");
    // A dead client cannot refresh.
    assert.equal((await db.query<{ v: { ok: boolean } }>("select oauth_exchange_grant('dead','refresh',$1,null,null,$2,$3) v", [sha("dead-refresh"), sha("x"), sha("y")])).rows[0].v.ok, false);
  } finally { await db.close(); }
});
