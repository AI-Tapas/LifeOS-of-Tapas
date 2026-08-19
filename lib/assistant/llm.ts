// Provider-agnostic LLM turn runner. One entry point, runLlmTurn, drives a
// single model turn (streamed text plus collected tool calls) over either
// wire format:
//   anthropic  official SDK, cache_control on the stable system prefix,
//              adaptive thinking, strict tools
//   openai     hand-rolled Chat Completions SSE against any compatible host
// The endpoint stays open: LLM_API_FORMAT + LLM_BASE_URL + LLM_API_KEY +
// LLM_MODEL select the provider (see lib/assistant/config.ts). Server-side
// only.

import Anthropic from "@anthropic-ai/sdk";
import { llmConfig, type LlmConfig } from "./config";
import type { SystemBlock } from "./prompt";
import { anthropicTools, type ToolDef } from "./tools";
import {
  toAnthropicMessages,
  toOpenAIMessages,
  toOpenAITools,
  newOpenAIStreamState,
  applyOpenAIChunk,
  finishOpenAIStream,
  type ConvMessage,
  type ToolCall,
} from "./wire";

export interface LlmTurn {
  text: string;
  calls: ToolCall[];
  stop: "end" | "tool_use" | "refusal";
}

export interface LlmTurnRequest {
  blocks: SystemBlock[];
  conv: ConvMessage[];
  tools: ToolDef[];
  maxTokens?: number;
  onText?: (delta: string) => void;
}

export async function runLlmTurn(req: LlmTurnRequest): Promise<LlmTurn> {
  const cfg = llmConfig();
  return cfg.format === "openai"
    ? runOpenAITurn(cfg, req)
    : runAnthropicTurn(cfg, req);
}

// ---------------------------------------------------------------------------
// Anthropic Messages (SDK)
// ---------------------------------------------------------------------------
function systemParam(blocks: SystemBlock[]): Anthropic.Messages.TextBlockParam[] {
  return blocks.map((b, i) => ({
    type: "text" as const,
    text: b.text,
    ...(b.stable && i === 0 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

async function runAnthropicTurn(
  cfg: LlmConfig,
  req: LlmTurnRequest
): Promise<LlmTurn> {
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });
  const stream = client.messages.stream({
    model: cfg.model,
    max_tokens: req.maxTokens ?? cfg.maxTokens,
    system: systemParam(req.blocks),
    messages: toAnthropicMessages(req.conv) as Anthropic.Messages.MessageParam[],
    tools: anthropicTools(req.tools),
    ...(cfg.thinking === "adaptive" ? { thinking: { type: "adaptive" as const } } : {}),
  });
  if (req.onText) stream.on("text", req.onText);
  const final = await stream.finalMessage();

  const text = final.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const calls: ToolCall[] = final.content
    .filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      name: b.name,
      input: (b.input ?? {}) as Record<string, unknown>,
    }));
  const stop =
    final.stop_reason === "refusal"
      ? ("refusal" as const)
      : final.stop_reason === "tool_use" && calls.length
        ? ("tool_use" as const)
        : ("end" as const);
  return { text, calls, stop };
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions (fetch + SSE)
// ---------------------------------------------------------------------------
async function runOpenAITurn(cfg: LlmConfig, req: LlmTurnRequest): Promise<LlmTurn> {
  const systemText = req.blocks.map((b) => b.text).join("\n\n");
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: req.maxTokens ?? cfg.maxTokens,
      stream: true,
      messages: toOpenAIMessages(systemText, req.conv),
      tools: toOpenAITools(req.tools, cfg.strictTools),
    }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `LLM request failed (${res.status}). ${detail.slice(0, 300)}`
    );
  }

  const state = newOpenAIStreamState();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data) as {
          choices?: Parameters<typeof applyOpenAIChunk>[1][];
        };
        const choice = chunk.choices?.[0];
        if (choice) {
          const delta = applyOpenAIChunk(state, choice);
          if (delta && req.onText) req.onText(delta);
        }
      } catch {
        // partial or non-JSON keep-alive line; ignore
      }
    }
  }
  return finishOpenAIStream(state);
}
