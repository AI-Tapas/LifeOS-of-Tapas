"use client";

// The approve button for a remote connection. Two taps, like the send queue:
// this grants an outside application ongoing access to the app's tools, so it
// must never be something a stray Enter key can do.

import Link from "next/link";
import { useState, useTransition } from "react";
import { approveConnectionAction } from "@/app/(app)/connect/actions";
import { btnPrimary, btnGhost, Card } from "@/components/ui";

export default function ConnectConsent({
  clientName,
  clientId,
  redirectUri,
  state,
  codeChallenge,
}: {
  clientName: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}) {
  const [armed, setArmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Card>
      <p className="text-sm">
        <span className="text-neutral-500">Application:</span>{" "}
        <span className="font-medium">{clientName}</span>
      </p>
      <p className="mt-1 break-all text-sm">
        <span className="text-neutral-500">Returns to:</span>{" "}
        <span className="font-mono text-[13px]">{redirectUri}</span>
      </p>
      <p className="mt-1 text-xs text-neutral-400">Client id {clientId}</p>

      <div className="mt-3 rounded-xl bg-neutral-50 p-3 text-sm dark:bg-neutral-950">
        <p className="font-medium">If you approve, this application can:</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-neutral-600 dark:text-neutral-300">
          <li>read your tasks, calendar and assistant context</li>
          <li>create tasks, reminders, notes, people and solo calendar events</li>
          <li>write email drafts and queue emails or invitations</li>
        </ul>
        <p className="mt-2 font-medium">It cannot:</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-neutral-600 dark:text-neutral-300">
          <li>send any email or invitation: those still wait for you here</li>
          <li>approve anything in the queue, or read your persona or accounts</li>
        </ul>
      </div>

      {message && <p className="mt-3 text-sm text-red-600">{message}</p>}

      <div className="mt-4 flex gap-2">
        {!armed ? (
          <button type="button" className={btnGhost} onClick={() => setArmed(true)}>
            Approve this connection
          </button>
        ) : (
          <button
            type="button"
            className={btnPrimary}
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await approveConnectionAction({
                  clientId,
                  redirectUri,
                  state,
                  codeChallenge,
                });
                if (r.ok) window.location.href = r.redirectTo;
                else setMessage(r.message);
              })
            }
          >
            {pending ? "Connecting..." : "Tap again to confirm"}
          </button>
        )}
        <Link href="/" className={btnGhost}>
          Cancel
        </Link>
      </div>
    </Card>
  );
}
