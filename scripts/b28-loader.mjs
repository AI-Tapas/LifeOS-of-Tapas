// B28 test helper: like b26-loader.mjs, but the REAL lib/trips/write.ts is
// loaded (the home city strip, the expense move and the journey join live
// there), so only the modules that reach the network are swapped for the
// in-memory stand-ins in b28-stubs.ts. Test-only.

import { existsSync } from "node:fs";

const stubs = new URL("./b28-stubs.ts", import.meta.url).href;
const STUBBED = new Set([
  "@/lib/assistant/actor",
  "@/lib/oauth/tokens",
  "@/lib/events/write",
  "@/lib/reminders/writer",
  "@/lib/family/sync",
  "@/lib/assistant/mail",
  "@/lib/assistant/context",
  "@/lib/brief/store-db",
  "@/lib/assistant/pdf-text",
  "@/lib/assistant/scan",
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
  // Extensionless relative imports (execute.ts uses "./tools").
  if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
    const url = new URL(specifier + ".ts", context.parentURL);
    if (existsSync(url)) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
}
