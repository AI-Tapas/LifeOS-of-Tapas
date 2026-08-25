"use client";

// Error boundary for the whole signed-in section. Without one, a single
// failure anywhere (a server action that times out, a bad render) replaces
// the entire app with Next's blank "This page couldn't load" screen, which
// says nothing and offers nothing. That is how a failing calendar sync took
// the Calendar tab down completely.
//
// This keeps the shell and the bottom bar usable, names the failure, and
// gives one button to retry. The message is shown deliberately: when
// something breaks on the phone, the reason should be readable there rather
// than only in a server log.

import { useEffect } from "react";
import Link from "next/link";
import { btnPrimary, btnGhost } from "@/components/ui";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Life OS error boundary:", error);
  }, [error]);

  return (
    <main className="py-6">
      <h1 className="text-[22px] font-bold tracking-tight">
        That screen did not load
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        The rest of the app is fine. Your data is untouched, and nothing was
        sent or changed.
      </p>

      <div className="mt-4 rounded-2xl border border-overdue/30 bg-overdue-soft p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-overdue">
          What went wrong
        </p>
        <p className="mt-1 break-words text-sm text-overdue">
          {error.message || "The server did not give a reason."}
        </p>
        {error.digest && (
          <p className="mt-2 font-mono text-[11px] text-overdue/80">
            reference {error.digest}
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={reset} className={btnPrimary}>
          Try again
        </button>
        <Link href="/" className={btnGhost + " inline-flex items-center"}>
          Back to Today
        </Link>
      </div>
    </main>
  );
}
