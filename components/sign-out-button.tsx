"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { announceSignOut, clearPrivateBrowserState } from "@/lib/auth/browser-session";

export default function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      const { error } = await createClient().auth.signOut();
      if (error) throw error;
      announceSignOut();
      await clearPrivateBrowserState();
      // A full navigation discards Next's in-memory private RSC/router cache.
      window.location.replace("/login");
    } catch {
      setError("Could not complete sign out. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <div>
      <button disabled={busy} onClick={signOut} className="rounded-lg border border-neutral-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-neutral-700">
        {busy ? "Signing out" : "Sign out"}
      </button>
      {error && <p role="alert" className="mt-2 text-sm text-overdue">{error}</p>}
    </div>
  );
}
