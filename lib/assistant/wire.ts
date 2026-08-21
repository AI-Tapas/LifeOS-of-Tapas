// Wire-format mapping between the assistant's neutral conversation shape and
// the two provider dialects: Anthropic Messages and OpenAI Chat Completions.
// Pure module (no fetch, no SDK) so scripts/m4.test.ts proves the mapping
// offline. The security model is format-independent: tool execution and the
// approval gates live behind these mappers and never change with the dialect.

import type { ToolDef } from "./tools.ts";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ConvMessage =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  // An assistant turn that called tools (optionally with leading text).
  | { kind: "tool_use"; text: string; calls: ToolCall[] }
  // The tool results answering the previous tool_use turn, in order.
  | {
      kind: "tool_results";
      results: { id: string; content: string; isError: boolean }[];
    };

// ---------------------------------------------------------------------------
// Anthropic Messages dialect
// ---------------------------------------------------------------------------
export function toAnthropicMessages(conv: ConvMessage[]): Array<{
  role: "user" | "assistant";
  content:
    | string
    | Array<Record<string, unknown>>;
}> {
  return conv.map((m) => {
    if (m.kind === "text") return { role: m.role, content: m.text };
    if (m.kind === "tool_use") {
      return {
        role: "assistant" as const,
        content: [
          ...(m.text ? [{ type: "text", text: m.text }] : []),
          ...m.calls.map((c) => ({
            type: "tool_use",
            id: c.id,
            name: c.name,
            input: c.input,
          })),
        ],
      };
    }
    return {
      role: "user" as const,
      content: m.results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.id,
        content: r.content,
        is_error: r.isError,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions dialect
// ---------------------------------------------------------------------------
export function toOpenAIMessages(
  systemText: string,
  conv: ConvMessage[]
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [
    { role: "system", content: systemText },
  ];
  for (const m of conv) {
    if (m.kind === "text") {
      out.push({ role: m.role, content: m.text });
    } else if (m.kind === "tool_use") {
      out.push({
        role: "assistant",
        content: m.text || null,
        tool_calls: m.calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        })),
      });
    } else {
      for (const r of m.results) {
        out.push({
          role: "tool",
          tool_call_id: r.id,
          content: r.isError ? `ERROR: ${r.content}` : r.content,
        });
      }
    }
  }
  return out;
}

export function toOpenAITools(
  defs: ToolDef[],
  strict: boolean
): Array<Record<string, unknown>> {
  return defs.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
      ...(strict ? { strict: true } : {}),
    },
  }));
}

// Tool arguments arrive as a JSON string in this dialect; a malformed string
// becomes an empty input (the executor then refuses on its own validation)
// rather than a crash.
export function parseOpenAIToolArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// Incremental assembly of streamed OpenAI tool calls (deltas arrive keyed by
// index, with the arguments string split across chunks).
export interface OpenAIStreamState {
  text: string;
  refusal: string;
  calls: { id: string; name: string; args: string }[];
  finish: string | null;
}

export function newOpenAIStreamState(): OpenAIStreamState {
  return { text: "", refusal: "", calls: [], finish: null };
}

export interface OpenAIChunkChoice {
  delta?: {
    content?: string | null;
    refusal?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
}

// Returns the text delta (if any) so the caller can stream it onwards.
export function applyOpenAIChunk(
  state: OpenAIStreamState,
  choice: OpenAIChunkChoice
): string {
  const d = choice.delta;
  let textDelta = "";
  if (d?.content) {
    state.text += d.content;
    textDelta = d.content;
  }
  if (d?.refusal) state.refusal += d.refusal;
  for (const tc of d?.tool_calls ?? []) {
    while (state.calls.length <= tc.index) {
      state.calls.push({ id: "", name: "", args: "" });
    }
    const slot = state.calls[tc.index];
    if (tc.id) slot.id = tc.id;
    if (tc.function?.name) slot.name += tc.function.name;
    if (tc.function?.arguments) slot.args += tc.function.arguments;
  }
  if (choice.finish_reason) state.finish = choice.finish_reason;
  return textDelta;
}

export function finishOpenAIStream(state: OpenAIStreamState): {
  text: string;
  calls: ToolCall[];
  stop: "end" | "tool_use" | "refusal";
} {
  const calls: ToolCall[] = state.calls
    .filter((c) => c.name)
    .map((c, i) => ({
      id: c.id || `call_${i}`,
      name: c.name,
      input: parseOpenAIToolArgs(c.args),
    }));
  const stop = state.refusal
    ? ("refusal" as const)
    : state.finish === "tool_calls" || calls.length
      ? ("tool_use" as const)
      : ("end" as const);
  return { text: state.text, calls, stop };
}

// Build the chat-completions URL from a configured base. Hosts differ in how
// much of the path they expect in the base (NVIDIA and OpenRouter want the
// /v1, Ollama's compatibility layer does not), and a base missing its version
// segment returns a bare 404 that reads like a broken key. Normalising here
// makes every reasonable spelling work:
//   .../v1                 -> .../v1/chat/completions
//   ...(no version)        -> .../v1/chat/completions
//   .../chat/completions   -> used as given
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(base)) return base;
  const lastSegment = base.split("/").pop() ?? "";
  return /^v\d+([a-z-]*)?$/i.test(lastSegment)
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
}
