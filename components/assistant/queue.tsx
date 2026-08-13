"use client";

// Approval queue, history with undo, and the audit trail. The pending cards
// show ground truth (red-team control 5): raw resolved addresses, the exact
// sending account, the full body untruncated, unverified and first-time
// recipient highlights. Approval is a deliberate two-tap press on a
// type="button" control: Enter in a form can never approve, and there is no
// approve-all.

import { useState, useTransition } from "react";
import {
  approveActionAction,
  rejectActionAction,
  undoActionAction,
} from "@/app/(app)/assistant/actions";

export interface RecipientFlag {
  email: string;
  flags: string[];
}

export interface PendingView {
  id: string;
  kind: string;
  title: string;
  created_at_label: string;
  account_label: string; // e.g. "ca_tapasnr (ca.tapasnr@gmail.com)"
  subject?: string;
  body?: string;
  to?: RecipientFlag[];
  cc?: RecipientFlag[];
  event_line?: string; // for invites: date/time/location line
  attendees?: RecipientFlag[];
}

export interface HistoryView {
  id: string;
  kind: string;
  title: string;
  status: string;
  when_label: string;
  undoable: boolean;
  error: string | null;
}

export interface AuditView {
  id: string;
  ts_label: string;
  actor: string;
  action: string;
  entity: string;
  detail: string;
}

function RecipientLine({ r }: { r: RecipientFlag }) {
  return (
    <li className="break-all font-mono text-[13px]">
      {r.email}
      {r.flags.map((f) => (
        <span
          key={f}
          className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-sans text-[11px] font-medium text-amber-900 dark:bg-amber-900/50 dark:text-amber-200"
        >
          {f}
        </span>
      ))}
    </li>
  );
}

export function PendingCard({ item }: { item: PendingView }) {
  const [armed, setArmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [gone, setGone] = useState(false);
  if (gone) return null;

  const act = (fn: (id: string) => Promise<{ ok: boolean; message?: string }>) =>
    startTransition(async () => {
      const r = await fn(item.id);
      if (r.ok) setGone(true);
      else setMessage(r.message ?? "Something went wrong.");
    });

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        {item.kind === "send_email" ? "Email awaiting your approval" : "Invite awaiting your approval"}
      </p>
      <p className="mt-1 text-sm">
        <span className="text-neutral-500">From account:</span>{" "}
        <span className="font-medium">{item.account_label}</span>
      </p>

      {item.to && (
        <div className="mt-2 text-sm">
          <p className="text-neutral-500">To:</p>
          <ul className="mt-0.5 space-y-0.5">
            {item.to.map((r) => (
              <RecipientLine key={r.email} r={r} />
            ))}
          </ul>
        </div>
      )}
      {item.cc && item.cc.length > 0 && (
        <div className="mt-2 text-sm">
          <p className="text-neutral-500">Cc:</p>
          <ul className="mt-0.5 space-y-0.5">
            {item.cc.map((r) => (
              <RecipientLine key={r.email} r={r} />
            ))}
          </ul>
        </div>
      )}
      {item.attendees && (
        <div className="mt-2 text-sm">
          <p className="text-neutral-500">Invitees:</p>
          <ul className="mt-0.5 space-y-0.5">
            {item.attendees.map((r) => (
              <RecipientLine key={r.email} r={r} />
            ))}
          </ul>
        </div>
      )}

      {item.event_line && <p className="mt-2 text-sm">{item.event_line}</p>}
      {item.subject && (
        <p className="mt-2 text-sm font-medium">Subject: {item.subject}</p>
      )}
      {item.body && (
        <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl bg-neutral-50 p-3 font-sans text-sm dark:bg-neutral-950">
          {item.body}
        </pre>
      )}
      <p className="mt-2 text-xs text-neutral-400">Proposed {item.created_at_label}</p>

      {message && <p className="mt-2 text-sm text-red-600">{message}</p>}

      <div className="mt-3 flex gap-2">
        {!armed ? (
          <button
            type="button"
            onClick={() => setArmed(true)}
            disabled={pending}
            className="rounded-xl border border-indigo-600 px-4 py-2 text-sm font-medium text-indigo-600 disabled:opacity-50"
          >
            {item.kind === "send_email" ? "Approve send" : "Approve invite"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => act(approveActionAction)}
            disabled={pending}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "Sending..." : "Tap again to confirm"}
          </button>
        )}
        <button
          type="button"
          onClick={() => act(rejectActionAction)}
          disabled={pending}
          className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-neutral-700"
        >
          Reject
        </button>
        {armed && !pending && (
          <button
            type="button"
            onClick={() => setArmed(false)}
            className="px-2 text-sm text-neutral-500"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export function HistoryRow({ item }: { item: HistoryView }) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [undone, setUndone] = useState(false);

  const statusColor =
    item.status === "executed"
      ? "text-green-700 dark:text-green-400"
      : item.status === "failed"
        ? "text-red-600"
        : "text-neutral-500";

  return (
    <li className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{item.title || item.kind}</p>
        <p className="text-xs text-neutral-500">
          {item.kind} <span className={statusColor}>{undone ? "undone" : item.status}</span>{" "}
          {item.when_label}
        </p>
        {item.error && <p className="text-xs text-red-600">{item.error}</p>}
        {message && <p className="text-xs text-red-600">{message}</p>}
      </div>
      {item.undoable && !undone && (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await undoActionAction(item.id);
              if (r.ok) setUndone(true);
              else setMessage(r.message ?? "Undo failed.");
            })
          }
          className="shrink-0 rounded-lg border border-neutral-300 px-3 py-1 text-xs font-medium disabled:opacity-50 dark:border-neutral-700"
        >
          {pending ? "Undoing..." : "Undo"}
        </button>
      )}
    </li>
  );
}

export function AuditList({ rows }: { rows: AuditView[] }) {
  if (!rows.length) {
    return <p className="text-sm text-neutral-500">Nothing logged yet.</p>;
  }
  return (
    <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
      {rows.map((r) => (
        <li key={r.id} className="py-2 first:pt-0 last:pb-0">
          <p className="text-sm">
            <span className="font-medium">{r.action}</span>{" "}
            <span className="text-neutral-500">on {r.entity}</span>
          </p>
          <p className="text-xs text-neutral-500">
            {r.actor} at {r.ts_label}
            {r.detail ? `, ${r.detail}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}
