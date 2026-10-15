// Shared-secret stdio adapter. Both transports use the SAME permission and
// durable dispatch boundary; approval is deliberately absent.
import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { serviceActor } from "@/lib/assistant/actor";
import { ALL_CAPABILITIES, type McpContext } from "@/lib/mcp/permissions";
import { dispatch, manifest } from "@/lib/mcp/dispatch";
import { isObject, readJson } from "@/lib/mcp/http";
import { appOrigin } from "@/lib/mcp/origin";
import { failure } from "@/lib/mcp/operations";
import { runNextMcpJob } from "@/lib/mcp/jobs";
import { listResources, readResource, listPrompts, getPrompt } from "@/lib/mcp/catalog";
export const runtime = "nodejs";
export const maxDuration = 300;
function tokenOk(header: string | null): boolean {
  const expected = process.env.LIFEOS_MCP_TOKEN;
  if (!expected || expected.length < 24 || !header?.match(/^Bearer\s+/i)) return false;
  const a = Buffer.from(header.replace(/^Bearer\s+/i, "")); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function POST(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== appOrigin(req)) return Response.json({error:"Unapproved Origin."}, {status:403});
  if (!tokenOk(req.headers.get("authorization"))) return Response.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const body = await readJson(req);
    if (!isObject(body)) return Response.json({ error: "Body must be an object." }, { status: 400 });
    const actor = await serviceActor();
    const context: McpContext = { clientId: "shared-secret", userId: actor.userId, capabilities: ALL_CAPABILITIES };
    const entries = manifest(context); const names = new Set(entries.map(e => e.name));
    let result: unknown;
    if (body.op === "manifest") result = { read_tools: entries.filter(e => e.read_only), write_tools: entries.filter(e => !e.read_only), resources: listResources(names), prompts: listPrompts(names) };
    else if (body.op === "resource") result = await readResource(String(body.uri ?? ""), names, (name, input) => dispatch(context, name, input));
    else if (body.op === "prompt") result = getPrompt(String(body.name ?? ""), names);
    else if ((body.op === "read" || body.op === "write") && typeof body.tool === "string" && (body.input === undefined || isObject(body.input))) {
      const entry = entries.find(e => e.name === body.tool);
      if (!entry || entry.read_only !== (body.op === "read")) return Response.json({ error: "Unknown tool or wrong operation." }, { status: 400 });
      result = await dispatch(context, body.tool, body.input ?? {});
      if (body.tool === "lifeos_start_scan_job") after(async () => { await runNextMcpJob(); });
    } else return Response.json({ error: "Invalid operation or input." }, { status: 400 });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) { return Response.json(failure(error), { status: 400, headers: { "cache-control": "no-store" } }); }
}
