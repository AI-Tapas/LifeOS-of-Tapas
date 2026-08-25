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

// Wrap a server action body so a throw becomes a readable result instead of a
// blank error screen. Framework signals pass straight through.
export async function reportable<T>(
  fn: () => Promise<T>
): Promise<T | { ok: false; message: string }> {
  try {
    return await fn();
  } catch (e) {
    if (isFrameworkSignal(e)) throw e;
    console.error("action failed:", e);
    return { ok: false, message: describeError(e) };
  }
}
