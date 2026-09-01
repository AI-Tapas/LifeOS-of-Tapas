// Priority provenance. Pure, so scripts/b3.test.ts proves it offline, the
// same pattern as triage.ts and transitions.ts.
//
// One rule stands above the rest: HIS HAND ALWAYS WINS, PERMANENTLY. A
// priority he set himself is priority_source 'manual', and no assistant path
// may overwrite it, in either direction, ever. Not the mail scanner, not the
// chat, not either MCP connector. He corrects it once and it stays corrected.
//
// The second rule: an assistant priority with no reason is refused. The
// reason is the whole point. It is what lets him look at "Do first" and
// disagree with it.
//
// Relative .ts import so node --test (type stripping, no bundler) resolves
// the module, same as triage.ts and core.ts do.

export type TaskPriority = "low" | "medium" | "high";
export type PrioritySource = "manual" | "assistant";

// Who is asking for the write.
//   app       the app's own forms. The ONLY origin that may write 'manual'.
//   assistant chat, mail scan, and both MCP connectors.
//   undo      restoring a snapshot taken before an assistant write. Not a
//             fresh judgment, so it carries the old source and reason back
//             verbatim, and it still refuses to touch a manual priority
//             (he may have re-rated the task in the meantime).
export type PriorityOrigin = "app" | "assistant" | "undo";

export interface PriorityRequest {
  priority?: TaskPriority;
  priority_reason?: string | null;
  // Read on the 'undo' origin only. A tool cannot reach this: no tool schema
  // declares priority_source, and the executor builds its own input object.
  priority_source?: PrioritySource;
}

export interface PriorityCurrent {
  priority: TaskPriority;
  priority_source: PrioritySource;
}

export interface PriorityFields {
  priority: TaskPriority;
  priority_source: PrioritySource;
  priority_reason: string | null;
}

export type PriorityDecision =
  // Write these three columns.
  | { kind: "write"; fields: PriorityFields }
  // Leave the priority columns alone; nothing was asked for, or nothing changed.
  | { kind: "none" }
  // His hand wins. The rest of the write goes ahead; the caller reports this.
  | { kind: "keep"; note: string }
  // The whole write is refused: the assistant named a priority with no reason.
  | { kind: "refuse"; message: string };

// One short sentence. Long enough for "statutory deadline, penalty for late
// filing", short enough that it can never become a paragraph on a task row.
export const REASON_MAX = 200;

export function cleanReason(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  // Collapsed to a single line: this is rendered as a quiet footnote, and a
  // reason arriving from scanned mail must not be able to shape the layout.
  const one = raw.replace(/\s+/g, " ").trim();
  return one ? one.slice(0, REASON_MAX) : null;
}

export function isPriority(v: unknown): v is TaskPriority {
  return v === "low" || v === "medium" || v === "high";
}

// current is null on a create, the row's present values on an update.
export function decidePriorityWrite(
  origin: PriorityOrigin,
  req: PriorityRequest,
  current: PriorityCurrent | null
): PriorityDecision {
  const reason = cleanReason(req.priority_reason);

  if (origin === "app") {
    // His own form. On a create, whatever the form sent is his. On an update,
    // only stamp his hand when the value actually changed, so saving an
    // unrelated edit does not silently erase a reason he has not read yet.
    if (req.priority === undefined) return { kind: "none" };
    if (current && current.priority === req.priority) return { kind: "none" };
    return {
      kind: "write",
      fields: { priority: req.priority, priority_source: "manual", priority_reason: null },
    };
  }

  // Everything below is an assistant path.
  if (current?.priority_source === "manual") {
    return {
      kind: "keep",
      note: "Priority left as Tapas set it; his own rating is never overwritten.",
    };
  }

  if (origin === "undo") {
    if (req.priority === undefined) return { kind: "none" };
    return {
      kind: "write",
      fields: {
        priority: req.priority,
        priority_source: req.priority_source ?? "assistant",
        priority_reason: reason,
      },
    };
  }

  if (req.priority === undefined) {
    // A create with no priority at all. The row takes the database default,
    // 'medium', and stays unrated by anyone: see isUnrated below.
    return current
      ? { kind: "none" }
      : {
          kind: "write",
          fields: { priority: "medium", priority_source: "assistant", priority_reason: null },
        };
  }

  if (!reason) {
    return {
      kind: "refuse",
      message:
        "A priority set by the assistant must carry a short reason. Say why in priority_reason, or leave the priority out.",
    };
  }

  return {
    kind: "write",
    fields: { priority: req.priority, priority_source: "assistant", priority_reason: reason },
  };
}

// ---------------------------------------------------------------------------
// Discoverability. Nobody has rated a task when it still sits on the default
// 'medium' with no reason attached: a task he moved to high or low is his
// judgment, and a task carrying a reason is the assistant's. Deliberately
// cheap, deliberately soft: this only decides whether one line of prompting
// appears on the Tasks overview.
// ---------------------------------------------------------------------------
export interface RatedTask {
  priority: TaskPriority;
  priority_reason?: string | null;
}

export function isUnrated(t: RatedTask): boolean {
  return t.priority === "medium" && !t.priority_reason;
}

// Below this many open tasks the share means nothing and the line stays away.
const MIN_TASKS = 5;
const SHARE = 0.6;

export function unratedPrompt(
  tasks: RatedTask[]
): { count: number; total: number } | null {
  if (tasks.length < MIN_TASKS) return null;
  const count = tasks.filter(isUnrated).length;
  if (count / tasks.length < SHARE) return null;
  return { count, total: tasks.length };
}
