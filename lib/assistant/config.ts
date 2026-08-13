// LLM provider configuration. Open by design: any endpoint that speaks the
// Anthropic Messages API works (Anthropic itself, OpenRouter, a LiteLLM proxy,
// Z.ai, Kimi and similar). Swap provider by changing three env vars, no code
// change:
//   LLM_BASE_URL  endpoint base (default https://api.anthropic.com)
//   LLM_API_KEY   key for that endpoint (falls back to ANTHROPIC_API_KEY)
//   LLM_MODEL     model id (default claude-opus-5)
// Server-side only; none of these are NEXT_PUBLIC_.

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  // 'adaptive' (default) lets the model pick its own thinking depth. Set
  // LLM_THINKING=off for providers that reject the thinking parameter.
  thinking: "adaptive" | "off";
}

export function llmConfig(): LlmConfig {
  const apiKey = process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_API_KEY (or ANTHROPIC_API_KEY) is not set");
  }
  return {
    baseUrl: process.env.LLM_BASE_URL || "https://api.anthropic.com",
    apiKey,
    model: process.env.LLM_MODEL || "claude-opus-5",
    maxTokens: Number(process.env.LLM_MAX_TOKENS || 4096),
    thinking: process.env.LLM_THINKING === "off" ? "off" : "adaptive",
  };
}
