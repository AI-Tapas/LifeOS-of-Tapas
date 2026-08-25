// Protected-resource metadata: tells a client which authorization server
// guards /api/mcp/http. Served at /.well-known/oauth-protected-resource.
import { protectedResourceMetadata } from "@/lib/mcp/oauth-core";
import { appOrigin } from "@/lib/mcp/origin";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  return Response.json(protectedResourceMetadata(appOrigin(req)), {
    headers: { "cache-control": "public, max-age=300" },
  });
}
