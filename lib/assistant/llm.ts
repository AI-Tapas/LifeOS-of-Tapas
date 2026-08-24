// Provider-agnostic LLM turn runner. One entry point, runLlmTurn, drives a
// single model turn (streamed text plus collected tool calls) over either
// wire format:
//   anthropic  official SDK, cache_control on the stable system prefix,
//              adaptive thinking, strict tools
//   openai     hand-rolled Chat Completions SSE against any compatible host
// The endpoint stays open: LLM_PROVIDER picks a preset, and the generic
// LLM_API_FORMAT / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL vars override it
// (see lib/assistant/config.ts). Server-side only.

import Anthropic from "@anthropic-ai/sdk";
import { llmConfig, type LlmConfig, type LlmOverride } from "./config";
import type { SystemBlock } from "./prompt";
import { anthropicTools, type ToolDef } from "./tools";
import {
  toAnthropicMessages,
  toOpenAIMessages,
  toOpenAITools,
  newOpenAIStreamState,
  applyOpenAIChunk,
  finishOpenAIStream,
  chatCompletionsUrl,
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
  // Per-activity model choice from Settings; falls back to the environment.
  override?: LlmOverride;
}

export async function runLlmTurn(req: LlmTurnRequest): Promise<LlmTurn> {
  const cfg = llmConfig(process.env, req.override);
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
  const url = chatCompletionsUrl(cfg.baseUrl);
  let res: Response;
  try {
    res = await fetch(url, {
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
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.name : "";
    throw new Error(
      reason === "TimeoutError" || reason === "AbortError"
        ? `The model at ${url} did not respond within ${Math.round(
            cfg.timeoutMs / 1000
          )} seconds (model "${cfg.model}", provider ${cfg.provider}).`
        : `Could not reach ${url} (provider ${cfg.provider}): ${
            e instanceof Error ? e.message : "network error"
          }`
    );
  }
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => "")).trim();
    // Name the endpoint and model: a 404 here is almost always a wrong base
    // URL or model id, and the provider's own message rarely says which.
    throw new Error(
      `LLM request failed (${res.status}) calling ${url} with model "${cfg.model}" ` +
        `[provider ${cfg.provider}]. ${detail.slice(0, 300)}`
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

// ---------------------------------------------------------------------------
// Health check: smallest possible round trip to the configured provider.
// Reports the provider, model and endpoint actually used, so a wrong model id
// or a stalled host is obvious. The API key is never included.
// ---------------------------------------------------------------------------
export interface LlmPing {
  ok: boolean;
  provider: string;
  format: string;
  endpoint: string;
  model: string;
  ms: number;
  reply?: string;
  error?: string;
}

export async function pingLlm(override?: LlmOverride): Promise<LlmPing> {
  const started = Date.now();
  let cfg: LlmConfig;
  try {
    cfg = llmConfig(process.env, override);
  } catch (e) {
    return {
      ok: false,
      provider: process.env.LLM_PROVIDER || "anthropic",
      format: "unknown",
      endpoint: "unknown",
      model: "unknown",
      ms: 0,
      error: e instanceof Error ? e.message : "configuration error",
    };
  }
  const endpoint =
    cfg.format === "openai"
      ? chatCompletionsUrl(cfg.baseUrl)
      : `${cfg.baseUrl}/v1/messages`;
  const base = {
    provider: cfg.provider,
    format: cfg.format,
    endpoint,
    model: cfg.model,
  };

  try {
    const reply = await pingOnce(cfg, endpoint);
    return { ok: true, ...base, ms: Date.now() - started, reply };
  } catch (e) {
    return {
      ok: false,
      ...base,
      ms: Date.now() - started,
      error: e instanceof Error ? e.message : "request failed",
    };
  }
}

// A health check must answer quickly even when the provider will not: the
// point is to report the problem, not to wait out the full chat timeout.
const PING_TIMEOUT_MS = 25000;

async function pingOnce(cfg: LlmConfig, endpoint: string): Promise<string> {
  const prompt = "Reply with the single word: ready";
  if (cfg.format === "anthropic") {
    const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });
    const msg = await client.messages.create(
      {
        model: cfg.model,
        max_tokens: 16,
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: PING_TIMEOUT_MS, maxRetries: 0 }
    );
    return msg.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
      .slice(0, 100);
  }

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 16,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    throw new Error(
      name === "TimeoutError" || name === "AbortError"
        ? `No reply within ${PING_TIMEOUT_MS / 1000} seconds. This model is too slow to answer even a one-word test.`
        : `Could not reach the endpoint: ${
            e instanceof Error ? e.message : "network error"
          }`
    );
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 300)}`);
  try {
    const j = JSON.parse(body) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
    };
    const m = j.choices?.[0]?.message;
    return (m?.content || m?.reasoning_content || "(empty reply)").trim().slice(0, 100);
  } catch {
    return body.slice(0, 100);
  }
}
