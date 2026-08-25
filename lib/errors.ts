// Turning an opaque server crash into something readable.
//
// Next strips error messages from production builds and leaves only a digest,
// which is the right default for a public site but useless for a single-user
// app whose owner is the only person who will ever see it. When a server
// action throws, the caller gets "An error occurred in the Server Components
// render" and a number, and the actual cause is only in a log nobody reads.
//
// Actions that return a result object should catch their own failures and
// report them, so the reason appears on screen next to the button that failed.

// Redirect and notFound are implemented as thrown values carrying a digest.
// They are control flow, not failures, and MUST be rethrown or the navigation
// they represent silently stops working.
export function isFrameworkSignal(e: unknown): boolean {
  const digest = (e as { digest?: unknown } | null)?.digest;
  return (
    typeof digest === "string" &&
    (digest.startsWith("NEXT_REDIRECT") || digest === "NEXT_NOT_FOUND")
  );
}

export function describeError(e: unknown): string {
  if (e instanceof Error) {
    // Postgres errors from supabase-js carry code/details/hint that say far
    // more than the message alone.
    const extra = e as Error & { code?: string; details?: string; hint?: string };
    return [
      e.message || e.name,
      extra.code ? `code ${extra.code}` : "",
      extra.details ?? "",
      extra.hint ?? "",
    ]
      .filter(Boolean)
      .join(", ")
      .slice(0, 400);
  }
  if (typeof e === "string") return e.slice(0, 400);
  try {
    return JSON.stringify(e).slice(0, 400);
  } catch {
    return "An unknown error.";
  }
}

// Record what actually happened, in a place that survives the request.
//
// Production hides the message and Vercel's log needs a login this machine
// does not have, so a failure that only exists in that log cannot be acted on.
// audit_log is already the app's durable record of what happened and to what,
// and the service client can write to it whether or not the caller still has a
// valid session, which is exactly the case that has been failing.
//
// Deliberately best effort: a logging failure must never mask the original
// fault, and must never become a second error on top of the first.
export async function recordEvent(kind: string, detail: string): Promise<void> {
  return recordFailure(kind, detail);
}

async function recordFailure(kind: string, detail: string): Promise<void> {
  try {
    const { createServiceClient } = await import("@/lib/supabase/service");
    const svc = createServiceClient();
    const { data: owner } = await svc.from("work_streams").select("user_id").limit(1).maybeSingle();
    if (!owner?.user_id) return;
    await svc.from("audit_log").insert({
      user_id: owner.user_id,
      // The enum has no 'system' member and adding one is a migration this
      // does not need: the action name already says what the row is.
      actor: "user",
      action: "action_failed",
      entity: "server_action",
      meta: { kind, detail: detail.slice(0, 500) },
    });
  } catch {
    // nothing useful left to do; the caller still gets its own answer
  }
}

// Wrap a server action body so a throw becomes a readable result instead of a
// blank error screen. Framework signals still pass through, because they are
// navigation rather than failure, but they are recorded on the way past: a
// redirect escaping to the user as an error screen is itself worth knowing.
export async function reportable<T>(
  fn: () => Promise<T>
): Promise<T | { ok: false; message: string }> {
  try {
    return await fn();
  } catch (e) {
    if (isFrameworkSignal(e)) {
      const digest = String((e as { digest?: unknown }).digest);
      await recordFailure("framework_signal", digest);
      throw e;
    }
    const detail = describeError(e);
    const stack = e instanceof Error && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : "";
    console.error("action failed:", e);
    await recordFailure("thrown", `${detail} :: ${stack}`);
    return { ok: false, message: detail };
  }
}
