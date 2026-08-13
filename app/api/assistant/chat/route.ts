// Assistant chat endpoint. Owner-session only. Streams newline-delimited JSON
// events: {t:"text",d}, {t:"tool",name,summary,queued}, {t:"notice",d},
// {t:"done"}, {t:"error",d}. The agentic loop runs server-side; tool calls
// dispatch through lib/assistant/execute.ts, where the autonomy buckets are
// enforced in code.

import { createClient } from "@/lib/supabase/server";
import { llmClient, systemParam, thinkingParam } from "@/lib/assistant/llm";
import { buildSystemBlocks } from "@/lib/assistant/prompt";
import { buildAppContext, loadActivePersona } from "@/lib/assistant/context";
import { anthropicTools } from "@/lib/assistant/tools";
import { executeToolCall } from "@/lib/assistant/execute";
import type Anthropic from "@anthropic-ai/sdk";

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

  const [appContext, personaMd] = await Promise.all([
    buildAppContext(supabase),
    loadActivePersona(supabase),
  ]);
  const system = systemParam(buildSystemBlocks(appContext, personaMd));
  const { client, cfg } = llmClient();
  const thinking = thinkingParam(cfg);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (obj: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

      try {
        const messages: Anthropic.Messages.MessageParam[] = history.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const msgStream = client.messages.stream({
            model: cfg.model,
            max_tokens: cfg.maxTokens,
            system,
            messages,
            tools: anthropicTools(),
            ...(thinking ? { thinking } : {}),
          });

          msgStream.on("text", (delta) => emit({ t: "text", d: delta }));

          const final = await msgStream.finalMessage();

          if (final.stop_reason === "refusal") {
            emit({ t: "notice", d: "The model declined this request." });
            break;
          }

          const toolUses = final.content.filter(
            (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
          );
          if (final.stop_reason !== "tool_use" || !toolUses.length) break;

          messages.push({ role: "assistant", content: final.content });
          const results: Anthropic.Messages.ToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            let reply: string;
            let isError = false;
            try {
              const outcome = await executeToolCall(
                tu.name,
                (tu.input ?? {}) as Record<string, unknown>
              );
              reply = outcome.reply;
              emit({
                t: "tool",
                name: tu.name,
                summary: outcome.reply,
                queued: outcome.queued ?? false,
              });
            } catch (e) {
              reply = e instanceof Error ? e.message : "Tool failed.";
              isError = true;
              emit({ t: "tool", name: tu.name, summary: reply, error: true });
            }
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: reply,
              is_error: isError,
            });
          }
          messages.push({ role: "user", content: results });
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
