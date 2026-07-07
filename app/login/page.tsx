"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const ALLOWED_EMAIL = "tapas.tnr@gmail.com";

// The signup allowlist is a DB trigger, so Auth surfaces its rejection as an
// opaque server error (sometimes an empty "{}" body). Map anything unreadable
// to plain copy instead of rendering the raw message.
function friendlySendError(message: string | undefined): string {
  const m = (message ?? "").trim();
  if (!m || m === "{}" || /database error|unexpected_failure/i.test(m)) {
    return "This email is not allowed.";
  }
  return m;
}

export default function LoginPage() {
  const [email, setEmail] = useState(ALLOWED_EMAIL);
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function sendOtp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/auth/confirm` },
    });
    setBusy(false);
    if (error) {
      setError(friendlySendError(error.message));
    } else {
      setStage("code");
    }
  }

  async function signInWithPasskey() {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPasskey();
    setBusy(false);
    if (error) {
      setError(error.message);
    } else {
      router.push("/");
      router.refresh();
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: code.trim(),
      type: "email",
    });
    setBusy(false);
    if (error) {
      setError(error.message);
    } else {
      router.push("/");
      router.refresh();
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Life OS</h1>
          <p className="text-sm text-neutral-500">Sign in to continue</p>
        </div>

        {stage === "email" ? (
          <form onSubmit={sendOtp} className="space-y-4">
            <label className="block space-y-1">
              <span className="text-sm font-medium">Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-indigo-600 px-3 py-2 font-medium text-white disabled:opacity-50"
            >
              {busy ? "Sending" : "Send sign-in code"}
            </button>
            <button
              type="button"
              onClick={signInWithPasskey}
              disabled={busy}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 font-medium disabled:opacity-50 dark:border-neutral-700"
            >
              Sign in with passkey
            </button>
          </form>
        ) : (
          <form onSubmit={verifyCode} className="space-y-4">
            <p className="text-sm text-neutral-500">
              A sign-in code and link were sent to {email}. Enter the code or
              open the link on this device.
            </p>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Code</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3 py-2 tracking-widest dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-indigo-600 px-3 py-2 font-medium text-white disabled:opacity-50"
            >
              {busy ? "Verifying" : "Verify"}
            </button>
            <button
              type="button"
              onClick={() => setStage("email")}
              className="w-full text-sm text-neutral-500 underline"
            >
              Use a different email
            </button>
          </form>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </main>
  );
}
