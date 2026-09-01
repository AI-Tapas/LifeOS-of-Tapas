// The chat transcript's rules, kept pure (backlog B6).
//
// M4 stored the thread in localStorage and said in the code why: device-local
// on purpose, move it when the same thread is needed on the phone and the
// laptop at once. That is now the case, so it lives in assistant_chat_turns.
//
// Two properties matter enough to be proven offline rather than trusted:
//
//   1. It TRIMS. A thread that only ever grows is a page view that gets slower
//      every week and a table nobody prunes. Only the newest KEEP_TURNS
//      survive a write, and the rest are deleted, not hidden.
//   2. What arrives from the browser is DATA. The one-time localStorage import
//      posts whatever a device happens to be holding, so it is validated and
//      capped here rather than written through.
//
// The transcript is his own words about his own work, which makes it as
// sensitive as the persona: owner session only. No tool reads it, the table's
// grants are revoked from service_role, and scripts/m7c.test.ts fails if a
// tool surface ever names it.

export const KEEP_TURNS = 40;

// Belt for the import path: one turn's text, and one thread, both bounded.
const MAX_CONTENT = 8000;
const MAX_TOOLS = 20;
const MAX_TOOL_TEXT = 300;

export type ChatRole = "user" | "assistant";

export interface ChatTool {
  name: string;
  summary: string;
  error?: boolean;
}

export interface ChatTurn {
  role: ChatRole;
  content: string;
  tools?: ChatTool[];
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function cleanTools(v: unknown): ChatTool[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_TOOLS).flatMap((t) => {
    if (!t || typeof t !== "object") return [];
    const o = t as Record<string, unknown>;
    const name = str(o.name, MAX_TOOL_TEXT);
    if (!name) return [];
    return [
      {
        name,
        summary: str(o.summary, MAX_TOOL_TEXT),
        ...(o.error === true ? { error: true } : {}),
      },
    ];
  });
}

// Turns a payload of unknown provenance into turns worth storing. Anything
// that is not a real turn is dropped rather than repaired: a half-understood
// transcript is worse than a short one.
export function sanitizeTurns(raw: unknown, keep = KEEP_TURNS): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.role !== "user" && o.role !== "assistant") continue;
    const content = str(o.content, MAX_CONTENT);
    const tools = cleanTools(o.tools);
    // An empty assistant turn that did nothing is noise. One that ran tools
    // said something, even with no prose.
    if (!content && !tools.length) continue;
    out.push({
      role: o.role,
      content,
      ...(tools.length ? { tools } : {}),
    });
  }
  return out.slice(-keep);
}

// Which stored rows a write should delete, given the thread's ids newest
// first. Everything past the newest `keep`, and nothing else: the caller
// deletes exactly these, so the thread cannot grow without limit and no row is
// left orphaned behind a "hidden" flag.
export function idsToTrim(idsNewestFirst: string[], keep = KEEP_TURNS): string[] {
  return idsNewestFirst.slice(keep);
}
