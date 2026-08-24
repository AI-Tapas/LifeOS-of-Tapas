// Provider health check. Owner-session only. Sends the smallest possible
// request to whichever provider is configured and reports what happened, so a
// misconfigured key, a dead model id or a stalled endpoint can be told apart
// without reading logs. Never returns the API key.

import { createClient } from "@/lib/supabase/server";
import { pingLlm } from "@/lib/assistant/llm";
import { loadLlmOverride } from "@/lib/assistant/settings";
import { anthropicTools } from "@/lib/assistant/tools";

export const runtime = "nodejs";
// The ping caps itself well below this; the ceiling only stops a hung
// provider from holding the function open.
export const maxDuration = 60;

// GET /api/assistant/health                      tests the saved chat model
// GET /api/assistant/health?role=scan            tests the saved scan model
// GET /api/assistant/health?provider=x&model=y   tests an unsaved choice, so
//   the Settings screen can verify a selection before it is saved
function countToolUnions(): number {
  let unions = 0;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.type) || obj.anyOf || obj.oneOf) unions += 1;
    Object.values(obj).forEach(walk);
  };
  for (const t of anthropicTools()) walk(t.input_schema);
  return unions;
}

export async function GET(req: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("not signed in", { status: 401 });

  const params = new URL(req.url).searchParams;
  const role = params.get("role") === "scan" ? "scan" : "chat";
  const provider = params.get("provider");
  const model = params.get("model");
  // An explicit provider in the query wins, so Test reflects the dropdown
  // rather than the last saved value. Unknown names are rejected inside
  // llmConfig, and only names travel: never a key.
  const override =
    provider !== null || model !== null
      ? { provider: provider || null, model: model || null }
      : await loadLlmOverride(supabase, role);
  const result = await pingLlm(override);
  // Which build is actually serving, and whether its tool schemas are the
  // fixed ones. Anthropic refuses a tool set with more than 16 union-typed
  // parameters, so tool_unions must read 0; a non-zero value means an older
  // deployment is still live.
  const build = {
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || "local").slice(0, 7),
    tool_unions: countToolUnions(),
  };
  return Response.json({ ...result, build }, {
    status: result.ok ? 200 : 502,
    headers: { "cache-control": "no-store" },
  });
}
