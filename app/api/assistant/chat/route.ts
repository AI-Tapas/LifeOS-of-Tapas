// Assistant chat endpoint. Owner-session only. Streams newline-delimited JSON
// events: {t:"text",d}, {t:"tool",name,summary,queued}, {t:"notice",d},
// {t:"done"}, {t:"error",d}. The agentic loop runs server-side over the
// provider-agnostic runner (lib/assistant/llm.ts); tool calls dispatch
// through lib/assistant/execute.ts, where the autonomy buckets are enforced
// in code regardless of which provider or wire format is configured.

import { createClient } from "@/lib/supabase/server";
import { runLlmTurn } from "@/lib/assistant/llm";
import { buildSystemBlocks } from "@/lib/assistant/prompt";
import { buildAppContext, loadActivePersona } from "@/lib/assistant/context";
import { loadLlmOverride } from "@/lib/assistant/settings";
import { TOOLS } from "@/lib/assistant/tools";
import { executeToolCall } from "@/lib/assistant/execute";
import type { ConvMessage } from "@/lib/assistant/wire";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_TURNS = 8;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function POST(req: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("not signed in", { status: 401 });

  let history: ChatMessage[];
  try {
    const body = (await req.json()) as { messages?: ChatMessage[] };
    history = (body.messages ?? [])
      .filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim()
      )
      .slice(-30);
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!history.length || history[history.length - 1].role !== "user") {
    return new Response("the last message must be from the user", { status: 400 });
  }

  const [appContext, personaMd, override] = await Promise.all([
    buildAppContext(supabase),
    loadActivePersona(supabase),
    loadLlmOverride(supabase, "chat"),
  ]);
  const blocks = buildSystemBlocks(appContext, personaMd);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (obj: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

      try {
        const conv: ConvMessage[] = history.map((m) => ({
          kind: "text",
          role: m.role,
          text: m.content,
        }));

        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const result = await runLlmTurn({
            blocks,
            conv,
            tools: TOOLS,
            override,
            onText: (d) => emit({ t: "text", d }),
          });

          if (result.stop === "refusal") {
            emit({ t: "notice", d: "The model declined this request." });
            break;
          }
          if (result.stop !== "tool_use") break;

          conv.push({ kind: "tool_use", text: result.text, calls: result.calls });
          const results: { id: string; content: string; isError: boolean }[] = [];
          for (const call of result.calls) {
            let reply: string;
            let isError = false;
            try {
              const outcome = await executeToolCall(call.name, call.input);
              reply = outcome.reply;
              emit({
                t: "tool",
                name: call.name,
                summary: outcome.reply,
                queued: outcome.queued ?? false,
              });
            } catch (e) {
              reply = e instanceof Error ? e.message : "Tool failed.";
              isError = true;
              emit({ t: "tool", name: call.name, summary: reply, error: true });
            }
            results.push({ id: call.id, content: reply, isError });
          }
          conv.push({ kind: "tool_results", results });
        }
        emit({ t: "done" });
      } catch (e) {
        emit({
          t: "error",
          d: e instanceof Error ? e.message : "The assistant hit an error.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
