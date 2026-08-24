// LLM provider configuration. Open by design, and multi-key by design: keys
// for several providers can sit side by side, with ONE variable choosing
// which is live.
//
//   LLM_PROVIDER   which preset is active: 'anthropic' (default), 'nvidia'
//                  or 'deepseek'
//
// Each preset knows its wire format, base URL, default model, and the env
// var holding its key, so switching provider means editing LLM_PROVIDER
// alone. Keys are never overwritten by a switch.
//
//   anthropic  ANTHROPIC_API_KEY (or LLM_API_KEY), ANTHROPIC_MODEL
//   nvidia     NVIDIA_API_KEY,    NVIDIA_MODEL
//   deepseek   DEEPSEEK_API_KEY,  DEEPSEEK_MODEL
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
  // Hard stop on a stalled provider, so the chat shows a message instead of
  // spinning forever. LLM_TIMEOUT_MS, default 90 seconds.
  timeoutMs: number;
  // NAME of the environment variable the key came from (never the key). A 401
  // is nearly always the wrong variable being picked up, so the health check
  // reports this.
  keySource: string;
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
    // Catalog ids match the build.nvidia.com path. NVIDIA retires models on
    // published end-of-life dates (a 410 "Gone" says so plainly), so check
    // the catalogue if this default ever stops working.
    model: "deepseek-ai/deepseek-v4-flash-0731",
    keyVars: ["NVIDIA_API_KEY", "LLM_API_KEY"],
    modelVar: "NVIDIA_MODEL",
  },
  deepseek: {
    format: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    // deepseek-v4-flash (cheap, fast) or deepseek-v4-pro. The legacy names
    // deepseek-chat and deepseek-reasoner were retired on 24 July 2026.
    model: "deepseek-v4-flash",
    keyVars: ["DEEPSEEK_API_KEY", "LLM_API_KEY"],
    modelVar: "DEEPSEEK_MODEL",
  },
};

function firstSet(names: string[], env: LlmEnv): string | undefined {
  return firstSetNamed(names, env)?.value;
}

function firstSetNamed(
  names: string[],
  env: LlmEnv
): { name: string; value: string } | undefined {
  for (const n of names) {
    const v = env[n];
    if (v && v.trim()) return { name: n, value: v.trim() };
  }
  return undefined;
}

// A per-activity choice made in Settings (chat and mail scan can differ).
// Only the provider NAME and model id travel from the database; keys never
// leave the server environment.
export interface LlmOverride {
  provider?: string | null;
  model?: string | null;
}

// Which presets exist, and whether each has a usable key in this environment.
// Used by the Settings screen; returns booleans only, never key material.
export function providerOptions(
  env: LlmEnv = process.env
): { name: string; hasKey: boolean; defaultModel: string }[] {
  return Object.entries(PRESETS).map(([name, p]) => ({
    name,
    hasKey: !!firstSet(p.keyVars, env),
    defaultModel: p.model,
  }));
}

export function llmConfig(
  env: LlmEnv = process.env,
  override?: LlmOverride
): LlmConfig {
  const envProvider = (env.LLM_PROVIDER || "anthropic").trim().toLowerCase();
  const name = (override?.provider || envProvider).trim().toLowerCase();
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(
      `LLM_PROVIDER "${name}" is not a known provider. Use ${Object.keys(PRESETS).join(
        " or "
      )}, or leave it unset and configure LLM_BASE_URL, LLM_API_KEY and LLM_MODEL directly.`
    );
  }

  // The generic LLM_* vars describe whatever LLM_PROVIDER points at. When
  // Settings selects a DIFFERENT provider they would be wrong for it, so the
  // preset supplies the endpoint and only the provider's OWN key variable is
  // consulted. Without this, picking anthropic while LLM_API_KEY holds an
  // NVIDIA key sends that key to Anthropic and earns a confusing 401.
  const settingsPicked = name !== envProvider;
  const keyVars = settingsPicked ? [preset.keyVars[0]] : preset.keyVars;
  const key = firstSetNamed(keyVars, env);
  if (!key) {
    throw new Error(
      `${preset.keyVars[0]} is not set, so the ${name} provider cannot be used. ` +
        `Add that variable, or choose a provider whose key is set.`
    );
  }
  const apiKey = key.value;
  const format = settingsPicked
    ? preset.format
    : env.LLM_API_FORMAT === "openai"
      ? "openai"
      : env.LLM_API_FORMAT === "anthropic"
        ? "anthropic"
        : preset.format;

  return {
    provider: name,
    format,
    baseUrl: (settingsPicked
      ? preset.baseUrl
      : env.LLM_BASE_URL || preset.baseUrl
    ).replace(/\/+$/, ""),
    apiKey,
    // Settings choice wins over the environment default, which in turn wins
    // over the preset built-in default.
    model:
      (override?.model || "").trim() ||
      firstSet([preset.modelVar, "LLM_MODEL"], env) ||
      preset.model,
    maxTokens: Number(env.LLM_MAX_TOKENS || 4096),
    thinking: env.LLM_THINKING === "off" ? "off" : "adaptive",
    strictTools: env.LLM_STRICT !== "off",
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 90000),
    keySource: key.name,
  };
}
