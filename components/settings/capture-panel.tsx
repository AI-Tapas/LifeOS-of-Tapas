"use client";

// Settings > Share to Life OS (B31). Tokens for the Apple Shortcut that posts
// text from the iOS share sheet to /api/capture. A new token is shown ONCE;
// the database keeps only its hash, so a lost token is replaced, not read back.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createCaptureTokenAction, revokeCaptureTokenAction } from "@/app/(app)/settings/actions";

export interface CaptureTokenView {
  id: string;
  label: string;
  created_label: string;
  last_used_label: string | null;
}

export default function CapturePanel({ tokens }: { tokens: CaptureTokenView[] }) {
  const [label, setLabel] = useState("iPhone");
  const [fresh, setFresh] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function create() {
    setMessage(null);
    setFresh(null);
    startTransition(async () => {
      const r = await createCaptureTokenAction(label);
      setMessage(r.message);
      if (r.ok && r.token) setFresh(r.token);
      router.refresh();
    });
  }

  function revoke(id: string) {
    startTransition(async () => {
      const r = await revokeCaptureTokenAction(id);
      setMessage(r.message);
      setFresh(null);
      router.refresh();
    });
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
      <p className="text-sm text-secondary">
        Share text from WhatsApp, Notes or anywhere into your Inbox here. You set up a Shortcut
        once, and it uses a token from this panel. The token can only add to your Inbox.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="block text-xs text-secondary">Label</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={60}
            className="min-h-11 rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={create}
          disabled={pending}
          className="press min-h-11 rounded-lg border border-border-strong px-3 py-2 text-sm disabled:opacity-50"
        >
          Create token
        </button>
      </div>
      {message && <p className="mt-2 text-sm text-accent">{message}</p>}
      {fresh && (
        <div className="mt-2 rounded-xl border border-today/30 bg-today-soft p-3">
          <p className="text-xs text-today">
            Copy this into your Shortcut now. It is shown once and never again. Do not share it.
          </p>
          <input
            readOnly
            value={fresh}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-2 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 font-mono text-xs"
          />
        </div>
      )}

      {tokens.length > 0 && (
        <ul className="mt-3 divide-y divide-border">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="font-medium">{t.label}</p>
                <p className="text-xs text-secondary">
                  Created {t.created_label}
                  {t.last_used_label ? `, last used ${t.last_used_label}` : ", not used yet"}
                </p>
              </div>
              <button
                type="button"
                disabled={pending}
                onClick={() => revoke(t.id)}
                className="shrink-0 rounded-lg border border-overdue/40 px-3 py-1 text-xs font-medium text-overdue disabled:opacity-50"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
