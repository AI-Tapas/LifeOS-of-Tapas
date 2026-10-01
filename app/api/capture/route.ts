// POST /api/capture: share-to-Life OS. See lib/capture/handle.ts and
// docs/share-to-life-os.md. Exempted from the cookie gate in proxy.ts because
// it authenticates itself with a capture token.

import { handleCapture } from "@/lib/capture/handle";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const reply = await handleCapture(createServiceClient(), {
    authorization: req.headers.get("authorization"),
    body: await req.text(),
  });
  return Response.json(reply.body, { status: reply.status });
}
