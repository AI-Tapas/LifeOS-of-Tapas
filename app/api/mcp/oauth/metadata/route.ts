// OAuth discovery. Reached at /.well-known/oauth-authorization-server through
// a rewrite in next.config.ts, because Next's router ignores dot-prefixed
// folders.
import { authorizationServerMetadata } from "@/lib/mcp/oauth-core";
import { appOrigin } from "@/lib/mcp/origin";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  return Response.json(authorizationServerMetadata(appOrigin(req)), {
    headers: { "cache-control": "public, max-age=300" },
  });
}
