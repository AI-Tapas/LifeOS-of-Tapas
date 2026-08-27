"use client";

// Error boundary for the whole signed-in section. Without one, a single
// failure anywhere replaces the entire app with Next's blank "This page
// couldn't load" screen, which says nothing and offers nothing.
//
// The most common failure it will ever catch is deployment skew, and that one
// it fixes by itself. Server actions are invoked by an ID baked into the page
// at build time; deploying changes every ID, so a tab opened before a deploy
// has buttons that post IDs the new server no longer recognises. Next then
// throws before any application code runs, which is why the failure is
// instant, appears only on clicks (the page itself still renders), and leaves
// nothing in any log. The remedy really is "reload the page", so the boundary
// does that once, automatically. The sessionStorage guard means a fault that
// survives a reload, a genuine server error, loops exactly zero times and is
// shown instead.

import { useEffect, useState } from "react";
import Link from "next/link";
import { btnPrimary, btnGhost } from "@/components/ui";

function reloadKey(digest: string | undefined): string {
  return `life_os_auto_reload_${digest ?? "no_digest"}`;
}

function alreadyTried(digest: string | undefined): boolean {
  try {
    return sessionStorage.getItem(reloadKey(digest)) === "1";
  } catch {
    // storage blocked: skip the auto-reload rather than risk a loop
    return true;
  }
}

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Decided once, synchronously, from sessionStorage at mount, so the effect
  // below only ever performs side effects and never has to setState itself.
  const [autoReloading] = useState(() => !alreadyTried(error.digest));

  useEffect(() => {
    console.error("Life OS error boundary:", error);
    if (!autoReloading) return;
    try {
      sessionStorage.setItem(reloadKey(error.digest), "1");
    } catch {
      // ignore: the lazy-init read above already decided to reload
    }
    window.location.reload();
  }, [error, autoReloading]);

  // The one automatic attempt is in flight; a flash of error UI would only
  // alarm for the case that fixes itself.
  if (autoReloading) {
    return (
      <main className="py-6">
        <p className="text-sm text-neutral-500">Reloading the app...</p>
      </main>
    );
  }

  return (
    <main className="py-6">
      <h1 className="text-[22px] font-bold tracking-tight">
        That screen did not load
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        The rest of the app is fine. Your data is untouched, and nothing was
        sent or changed. If the app was updated a moment ago, reloading usually
        clears this.
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
        <button
          type="button"
          onClick={() => window.location.reload()}
          className={btnPrimary}
        >
          Reload the app
        </button>
        <button type="button" onClick={reset} className={btnGhost}>
          Try again
        </button>
        <Link href="/" className={btnGhost + " inline-flex items-center"}>
          Back to Today
        </Link>
      </div>
    </main>
  );
}
