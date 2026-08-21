// LLM provider configuration. Open by design, and multi-key by design: keys
// for several providers can sit side by side, with ONE variable choosing
// which is live.
//
//   LLM_PROVIDER   which preset is active: 'anthropic' (default) or 'nvidia'
//
// Each preset knows its wire format, base URL, default model, and the env
// var holding its key, so switching provider means editing LLM_PROVIDER
// alone. Keys are never overwritten by a switch.
//
//   anthropic  ANTHROPIC_API_KEY (or LLM_API_KEY), ANTHROPIC_MODEL
//   nvidia     NVIDIA_API_KEY,    NVIDIA_MODEL
//
// Any preset value can be overridden by the generic vars, which also cover
// providers with no preset (OpenRouter, Groq, DeepSeek, Ollama, LiteLLM,
// Z.ai): LLM_API_FORMAT ('anthropic' | 'openai'), LLM_BASE_URL, LLM_API_KEY,
// LLM_MODEL. For the openai format the base URL must include the version
// path, e.g. https://integrate.api.nvidia.com/v1
//
// Server-side only; none of these are NEXT_PUBLIC_.

export interface LlmConfig {
  provider: string;
  format: "anthropic" | "openai";
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  // 'adaptive' (default) lets the model pick its own thinking depth. Set
  // LLM_THINKING=off for hosts that reject the parameter. Anthropic format
  // only.
  thinking: "adaptive" | "off";
  // Some OpenAI-compatible hosts reject the strict flag on tool schemas;
  // LLM_STRICT=off drops it. OpenAI format only.
  strictTools: boolean;
}

// Plain string map so callers (and the offline tests) can pass a literal
// object; process.env satisfies it.
export type LlmEnv = Record<string, string | undefined>;

interface Preset {
  format: "anthropic" | "openai";
  baseUrl: string;
  model: string;
  keyVars: string[]; // checked in order
  modelVar: string;
}

const PRESETS: Record<string, Preset> = {
  anthropic: {
    format: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-opus-5",
    keyVars: ["ANTHROPIC_API_KEY", "LLM_API_KEY"],
    modelVar: "ANTHROPIC_MODEL",
  },
  nvidia: {
    format: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "zai/glm-4.6",
    keyVars: ["NVIDIA_API_KEY", "LLM_API_KEY"],
    modelVar: "NVIDIA_MODEL",
  },
};

function firstSet(names: string[], env: LlmEnv): string | undefined {
  for (const n of names) {
    const v = env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

export function llmConfig(env: LlmEnv = process.env): LlmConfig {
  const name = (env.LLM_PROVIDER || "anthropic").trim().toLowerCase();
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(
      `LLM_PROVIDER "${name}" is not a known provider. Use ${Object.keys(PRESETS).join(
        " or "
      )}, or leave it unset and configure LLM_BASE_URL, LLM_API_KEY and LLM_MODEL directly.`
    );
  }

  // The generic vars override the preset, so an unlisted provider still works.
  const apiKey = firstSet(preset.keyVars, env);
  if (!apiKey) {
    throw new Error(
      `${preset.keyVars[0]} is not set, so the ${name} provider cannot be used. ` +
        `Set it, or point LLM_PROVIDER at a provider whose key is set.`
    );
  }
  const format =
    env.LLM_API_FORMAT === "openai"
      ? "openai"
      : env.LLM_API_FORMAT === "anthropic"
        ? "anthropic"
        : preset.format;

  return {
    provider: name,
    format,
    baseUrl: (env.LLM_BASE_URL || preset.baseUrl).replace(/\/+$/, ""),
    apiKey,
    model: firstSet([preset.modelVar, "LLM_MODEL"], env) || preset.model,
    maxTokens: Number(env.LLM_MAX_TOKENS || 4096),
    thinking: env.LLM_THINKING === "off" ? "off" : "adaptive",
    strictTools: env.LLM_STRICT !== "off",
  };
}
