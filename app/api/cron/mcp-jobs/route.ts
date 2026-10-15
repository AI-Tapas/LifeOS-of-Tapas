import { cronAuthorized } from "@/lib/cron/guard";
import { runNextMcpJob } from "@/lib/mcp/jobs";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(req: Request): Promise<Response> {
  if (!cronAuthorized(req.headers.get("authorization"))) return Response.json({ error: "Unauthorized." }, { status: 401 });
  return Response.json(await runNextMcpJob(), { headers: { "cache-control": "no-store" } });
}
