// Thin wrapper over the Anthropic SDK. The endpoint is open: LLM_BASE_URL,
// LLM_API_KEY and LLM_MODEL select any Anthropic-Messages-compatible provider
// (see lib/assistant/config.ts). Server-side only.

import Anthropic from "@anthropic-ai/sdk";
import { llmConfig, type LlmConfig } from "./config";
import type { SystemBlock } from "./prompt";

export function llmClient(): { client: Anthropic; cfg: LlmConfig } {
  const cfg = llmConfig();
  return {
    client: new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl }),
    cfg,
  };
}

// System blocks with cache_control on the stable prefix (the hard rules never
// change between requests, so they are the cacheable prefix).
export function systemParam(
  blocks: SystemBlock[]
): Anthropic.Messages.TextBlockParam[] {
  return blocks.map((b, i) => ({
    type: "text" as const,
    text: b.text,
    ...(b.stable && i === 0 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

export function thinkingParam(
  cfg: LlmConfig
): Anthropic.Messages.MessageCreateParams["thinking"] | undefined {
  return cfg.thinking === "adaptive" ? { type: "adaptive" } : undefined;
}
