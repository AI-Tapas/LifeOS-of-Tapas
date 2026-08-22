// Provider health check. Owner-session only. Sends the smallest possible
// request to whichever provider is configured and reports what happened, so a
// misconfigured key, a dead model id or a stalled endpoint can be told apart
// without reading logs. Never returns the API key.

import { createClient } from "@/lib/supabase/server";
import { pingLlm } from "@/lib/assistant/llm";
import { loadLlmOverride } from "@/lib/assistant/settings";

export const runtime = "nodejs";

// GET /api/assistant/health           tests the chat model
// GET /api/assistant/health?role=scan tests the mail-scan model
export async function GET(req: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("not signed in", { status: 401 });

  const role =
    new URL(req.url).searchParams.get("role") === "scan" ? "scan" : "chat";
  const result = await pingLlm(await loadLlmOverride(supabase, role));
  return Response.json(result, {
    status: result.ok ? 200 : 502,
    headers: { "cache-control": "no-store" },
  });
}
