// HTTP surface for the MCP connector. Authenticated by a shared secret in the
// Authorization header (LIFEOS_MCP_TOKEN), compared in constant time. This is
// the only door into the app that does not use a browser session, so it is
// deliberately narrow:
//
//   POST { op: "manifest" }                     the callable tools
//   POST { op: "read",  tool, input }           read-only queries
//   POST { op: "write", tool, input }           the assistant's own registry
//
// Approving, rejecting or executing a queued action is NOT available here.
// Those stay owner-session acts inside the app, so connecting an outside
// model can queue a send but can never authorise one.

import { timingSafeEqual } from "node:crypto";
import {
  runReadTool,
  runWriteTool,
  writeTools,
  READ_TOOL_NAMES,
  READ_TOOL_SCHEMAS as READ_SCHEMAS,
  READ_TOOL_DESCRIPTIONS as READ_DESCRIPTIONS,
} from "@/lib/assistant/mcp-api";

export const runtime = "nodejs";
export const maxDuration = 60;

function tokenOk(header: string | null): boolean {
  const expected = process.env.LIFEOS_MCP_TOKEN;
  if (!expected || expected.length < 24) return false; // refuse a weak secret
  const given = (header ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
  if (!tokenOk(req.headers.get("authorization"))) {
    return Response.json(
      { error: "Unauthorized. Set LIFEOS_MCP_TOKEN and send it as a bearer token." },
      { status: 401 }
    );
  }

  let body: { op?: string; tool?: string; input?: Record<string, unknown> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  try {
    if (body.op === "manifest") {
      return Response.json({
        read_tools: READ_TOOL_NAMES.map((name) => ({
          name,
          description: READ_DESCRIPTIONS[name],
          input_schema: READ_SCHEMAS[name],
          read_only: true,
        })),
        write_tools: writeTools().map((t) => ({
          // Prefixed so the tool cannot collide with another connector's.
          name: `lifeos_${t.name}`,
          description: t.description,
          input_schema: t.input_schema,
          read_only: false,
          // 'confirm' tools only ever queue; they never reach anybody.
          queues_for_approval: t.bucket === "confirm",
        })),
      });
    }

    const tool = body.tool ?? "";
    const input = body.input ?? {};

    if (body.op === "read") {
      if (!(READ_TOOL_NAMES as readonly string[]).includes(tool)) {
        return Response.json({ error: `Unknown read tool: ${tool}` }, { status: 400 });
      }
      return Response.json(await runReadTool(tool, input));
    }

    if (body.op === "write") {
      const bare = tool.replace(/^lifeos_/, "");
      if (!writeTools().some((t) => t.name === bare)) {
        return Response.json(
          { error: `Unknown or unavailable write tool: ${tool}` },
          { status: 400 }
        );
      }
      return Response.json(await runWriteTool(bare, input));
    }

    return Response.json(
      { error: 'op must be "manifest", "read" or "write".' },
      { status: 400 }
    );
  } catch (e) {
    // Readable, but never internal detail: this endpoint is reachable by a
    // token holder, so errors stay generic-but-useful.
    return Response.json(
      { error: e instanceof Error ? e.message : "The operation failed." },
      { status: 400 }
    );
  }
}
