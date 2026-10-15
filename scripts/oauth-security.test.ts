import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";
import * as core from "../lib/mcp/oauth-core.ts";
import * as http from "../lib/mcp/oauth-http.ts";
import * as permissions from "../lib/mcp/permissions.ts";

function route(file: string, service: unknown, session?: unknown) {
  const exports: Record<string, unknown> = {};
  const imports: Record<string, unknown> = {
    "node:crypto": crypto, "@/lib/mcp/oauth-core": core, "@/lib/mcp/oauth-http": http,
    "@/lib/mcp/permissions": permissions, "@/lib/mcp/origin": { appOrigin: () => "https://app.example", requestOrigin: () => "https://app.example" },
    "@/lib/supabase/service": { createServiceClient: () => service },
    "@/lib/supabase/server": { createClient: async () => session },
    "@/lib/assistant/actor": { serviceActor: async () => ({ userId: "owner" }) },
  };
  const code = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: (name: string) => { assert(name in imports, name); return imports[name]; }, Request, Response, URLSearchParams, URL, Buffer, TextDecoder, console });
  return exports as { POST: (req: Request) => Promise<Response>; revokeConnectionAction: (clientId: string) => Promise<{ ok: boolean }> };
}
const request = (body: unknown) => new Request("https://app.example/api/mcp/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("registration validates shape and bounds before database work", async () => {
  const handler = route("app/api/mcp/oauth/register/route.ts", { rpc() { throw new Error("Database must not be touched"); } });
  for (const value of [null, [], "bad", { redirect_uris: "https://client.example/cb" }, { client_name: 7, redirect_uris: ["https://client.example/cb"] }, { redirect_uris: Array(11).fill("https://client.example/cb") }, { redirect_uris: ["https://name:password@client.example/cb"] }, { redirect_uris: ["https://client.example/cb#fragment"] }, { client_name: "a".repeat(121), redirect_uris: ["https://client.example/cb"] }]) {
    assert.equal((await handler.POST(request(value))).status, 400);
  }
  assert.equal((await handler.POST(request({ client_name: "a".repeat(20_000) }))).status, 400);
});

test("public registration returns retry advice on the shared database quota", async () => {
  const handler = route("app/api/mcp/oauth/register/route.ts", { rpc: async () => ({ data: { ok: false, error: "rate_limited" }, error: null }) });
  const response = await handler.POST(request({ client_name: "Example", redirect_uris: ["https://client.example/cb"] }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "3600");
});

test("OAuth body limits apply to actual streamed bytes, not only content length", async () => {
  const req = new Request("https://app.example/token", { method: "POST", body: "x".repeat(17_000) });
  await assert.rejects(http.readBoundedText(req), /too large/);
  for (const bad of [null, [], { token: 4 }]) await assert.rejects(http.readOAuthParams(request(bad)));
});

test("token endpoint uses one transaction and does not return credentials on RPC failure", async () => {
  let calls = 0;
  const handler = route("app/api/mcp/oauth/token/route.ts", { rpc: async (name: string, args: Record<string, string>) => {
    calls++; assert.equal(name, "oauth_exchange_grant"); assert.equal(args.p_kind, "code"); assert.equal(args.p_code_challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    assert.equal(args.p_access_hash.length, 64); assert.equal(args.p_refresh_hash.length, 64);
    return { data: null, error: { message: "private database detail" } };
  } });
  const response = await handler.POST(request({ grant_type: "authorization_code", client_id: "client", code: "code", redirect_uri: "https://client.example/cb", code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk" }));
  assert.equal(calls, 1); assert.equal(response.status, 503);
  const body = await response.json(); assert.equal(body.access_token, undefined); assert(!JSON.stringify(body).includes("private database detail"));
});

test("Disconnect reports returned database failures instead of false success", async () => {
  const session = { auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) } };
  const handler = route("app/(app)/connect/actions.ts", { rpc: async () => ({ data: null, error: { message: "failure" } }) }, session);
  assert.equal((await handler.revokeConnectionAction("client")).ok, false);
  const healthy = route("app/(app)/connect/actions.ts", { rpc: async () => ({ data: { ok: true }, error: null }) }, session);
  assert.equal((await healthy.revokeConnectionAction("client")).ok, true);
});

test("revocation hides unknown credentials while surfacing storage failure", async () => {
  const failing = route("app/api/mcp/oauth/revoke/route.ts", { rpc: async () => ({ data: null, error: { message: "failure" } }) });
  assert.equal((await failing.POST(request({ token: "secret" }))).status, 503);
  const unknown = route("app/api/mcp/oauth/revoke/route.ts", { rpc: async () => ({ data: { ok: true }, error: null }) });
  assert.equal((await unknown.POST(request({ token: "unknown" }))).status, 200);
});

test("unapproved registrations expire; disconnected clients cannot be reauthorized", () => {
  const now = new Date("2026-10-15T00:00:00Z");
  const base = { approved_at: null, revoked_at: null, registration_expires_at: "2026-10-16T00:00:00Z" };
  assert(core.clientCanAuthorize(base, now));
  assert(!core.clientCanAuthorize({ ...base, registration_expires_at: "2026-10-14T00:00:00Z" }, now));
  assert(!core.clientCanAuthorize({ ...base, approved_at: now.toISOString(), revoked_at: now.toISOString() }, now));
});


test("consent requires same-origin owner approval and persists only explicitly selected capabilities", async () => {
  let calls = 0;
  const session = { auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) }, from: () => ({ select: () => ({ eq: async () => ({ data: [{ slot: "allowed", id: "allowed-stream" }], error: null }) }) }) };
  const handler = route("app/api/mcp/oauth/approve/route.ts", { rpc: async (name: string, args: Record<string, unknown>) => {
    calls++; assert.equal(name, "oauth_approve_client"); assert.deepEqual(JSON.parse(JSON.stringify(args.p_capabilities)), permissions.DEFAULT_CAPABILITIES);
    return { data: { ok: true }, error: null };
  } }, session);
  const valid = { client_id: "client", redirect_uri: "https://client.example/cb", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", read: "on", mailboxes_mode: "all", work_streams_mode: "all" };
  const form = (values: Record<string, string>, origin = "https://app.example") => new Request("https://app.example/api/mcp/oauth/approve", { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) });
  assert.equal((await handler.POST(form(valid, "https://attacker.example"))).status, 403);
  assert.equal((await handler.POST(form(valid, ""))).status, 403);
  assert.equal((await handler.POST(form({ ...valid, read: "" }))).status, 400);
  assert.equal((await handler.POST(form({ ...valid, attachments: "on" }))).status, 400);
  assert.equal((await handler.POST(form({ ...valid, mailboxes_mode: "selected", mailboxes: "foreign-mailbox" }))).status, 400);
  assert.equal((await handler.POST(form({ ...valid, work_streams_mode: "selected", work_streams: "foreign-stream" }))).status, 400);
  assert.equal(calls, 0);
  const response = await handler.POST(form(valid));
  assert.equal(response.status, 303); assert.equal(calls, 1);
  assert.equal(new URL(response.headers.get("location")!).origin, "https://client.example");
});
