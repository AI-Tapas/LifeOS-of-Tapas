// B34 test helper: the b24 loader, except that mail.ts is the REAL module
// (so the targeted fetch is exercised) and its only outside call,
// withResourceAuth, is the stand-in in b34-stubs.ts. Test-only.

import { existsSync } from "node:fs";

const b24 = new URL("./b24-stubs.ts", import.meta.url).href;
const b34 = new URL("./b34-stubs.ts", import.meta.url).href;
const B24 = new Set([
  "@/lib/assistant/actor",
  "@/lib/assistant/llm",
  "@/lib/assistant/settings",
  "@/lib/assistant/execute",
  "@/lib/assistant/pdf-text",
  "@/lib/tasks/write",
]);

export async function resolve(specifier, context, next) {
  if (B24.has(specifier)) return { url: b24, shortCircuit: true };
  if (specifier === "@/lib/oauth/tokens") return { url: b34, shortCircuit: true };
  if (specifier.startsWith("@/")) {
    const base = new URL("../" + specifier.slice(2), import.meta.url);
    for (const suffix of [".ts", "/index.ts"]) {
      const url = new URL(base.href + suffix);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
