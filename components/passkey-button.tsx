"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function PasskeyButton() {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function register() {
    setBusy(true);
    setMessage(null);
    const { error } = await createClient().auth.registerPasskey();
    setBusy(false);
    setMessage(error ? error.message : "Passkey registered on this device.");
  }

  return (
    <div>
      <button
        onClick={register}
        disabled={busy}
        className="rounded-lg border border-neutral-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-neutral-700"
      >
        {busy ? "Waiting for device" : "Add a passkey for this device"}
      </button>
      {message && (
        <p className="mt-2 text-sm text-neutral-500">{message}</p>
      )}
    </div>
  );
}
