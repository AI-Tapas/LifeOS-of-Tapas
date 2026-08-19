// LLM provider configuration. Open by design: two wire formats cover
// effectively every provider. Swap by env var, no code change:
//   LLM_API_FORMAT  'anthropic' (default) or 'openai'
//     anthropic: the Anthropic Messages API (api.anthropic.com, Z.ai's
//       anthropic endpoint, LiteLLM's messages route). Keeps prompt caching
//       and adaptive thinking.
//     openai: OpenAI-style Chat Completions (/chat/completions under the
//       base URL). Covers NVIDIA Build, OpenRouter, Groq, DeepSeek, Ollama,
//       Mistral and the rest. For this format LLM_BASE_URL must include the
//       version path, e.g. https://integrate.api.nvidia.com/v1.
//   LLM_BASE_URL  endpoint base (default https://api.anthropic.com)
//   LLM_API_KEY   key for that endpoint (falls back to ANTHROPIC_API_KEY)
//   LLM_MODEL     model id (default claude-opus-5)
// Server-side only; none of these are NEXT_PUBLIC_.

export interface LlmConfig {
  format: "anthropic" | "openai";
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  // 'adaptive' (default) lets the model pick its own thinking depth. Set
  // LLM_THINKING=off for providers that reject the thinking parameter.
  // Ignored for the openai format.
  thinking: "adaptive" | "off";
  // Some OpenAI-compatible hosts reject the strict flag on tool schemas;
  // LLM_STRICT=off drops it. Ignored for the anthropic format (always strict).
  strictTools: boolean;
}

export function llmConfig(): LlmConfig {
  const apiKey = process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_API_KEY (or ANTHROPIC_API_KEY) is not set");
  }
  const format = process.env.LLM_API_FORMAT === "openai" ? "openai" : "anthropic";
  return {
    format,
    baseUrl:
      (process.env.LLM_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, ""),
    apiKey,
    model: process.env.LLM_MODEL || "claude-opus-5",
    maxTokens: Number(process.env.LLM_MAX_TOKENS || 4096),
    thinking: process.env.LLM_THINKING === "off" ? "off" : "adaptive",
    strictTools: process.env.LLM_STRICT !== "off",
  };
}
