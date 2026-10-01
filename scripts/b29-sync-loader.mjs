// B29 test helper: loads the REAL lib/family/sync.ts with the "@/" alias, and
// swaps the two modules that reach a database or Google for the stand-ins in
// b29-sync-stubs.ts. Test-only.

import { existsSync } from "node:fs";

const stubs = new URL("./b29-sync-stubs.ts", import.meta.url).href;
const STUBBED = new Set(["@/lib/supabase/service", "@/lib/reminders/writer"]);

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
