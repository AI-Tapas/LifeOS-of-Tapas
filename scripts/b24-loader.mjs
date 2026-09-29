// B24 test helper: lets node --test load the real scan code (which uses the
// "@/" path alias) and swaps the modules that touch the network or Supabase
// for the in-memory stubs in b24-stubs.ts. Test-only.

import { existsSync } from "node:fs";

const stubs = new URL("./b24-stubs.ts", import.meta.url).href;
const STUBBED = new Set([
  "@/lib/assistant/actor",
  "@/lib/assistant/llm",
  "@/lib/assistant/settings",
  "@/lib/assistant/mail",
  "@/lib/assistant/execute",
  "@/lib/assistant/pdf-text",
  "@/lib/tasks/write",
]);

export async function resolve(specifier, context, next) {
  if (STUBBED.has(specifier)) return { url: stubs, shortCircuit: true };
  if (specifier.startsWith("@/")) {
    const base = new URL("../" + specifier.slice(2), import.meta.url);
    for (const suffix of [".ts", "/index.ts"]) {
      const url = new URL(base.href + suffix);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
