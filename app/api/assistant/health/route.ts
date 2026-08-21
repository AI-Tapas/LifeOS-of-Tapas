// Provider health check. Owner-session only. Sends the smallest possible
// request to whichever provider is configured and reports what happened, so a
// misconfigured key, a dead model id or a stalled endpoint can be told apart
// without reading logs. Never returns the API key.

import { createClient } from "@/lib/supabase/server";
import { pingLlm } from "@/lib/assistant/llm";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("not signed in", { status: 401 });

  const result = await pingLlm();
  return Response.json(result, {
    status: result.ok ? 200 : 502,
    headers: { "cache-control": "no-store" },
  });
}
