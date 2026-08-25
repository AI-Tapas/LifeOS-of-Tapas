"use client";

// Settings > Connected applications. Shows every remote client that has been
// approved, and lets one be cut off. Revoking kills its live tokens and its
// registration, so it must sign in again from scratch.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { revokeConnectionAction } from "@/app/(app)/connect/actions";
import { Empty } from "@/components/ui";

export interface ConnectionView {
  client_id: string;
  client_name: string;
  created_label: string;
  last_used_label: string | null;
  active_tokens: number;
}

export default function ConnectionsPanel({ items }: { items: ConnectionView[] }) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (!items.length) {
    return (
      <Empty>
        No applications are connected. Adding one starts from ChatGPT or Claude,
        and lands on an approval screen here.
      </Empty>
    );
  }

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      {message && <p className="mb-2 text-sm text-accent">{message}</p>}
      <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {items.map((c) => (
          <li
            key={c.client_id}
            className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <p className="font-medium">{c.client_name}</p>
              <p className="text-xs text-neutral-500">
                Connected {c.created_label}
                {c.last_used_label ? `, last used ${c.last_used_label}` : ", not used yet"}
                {c.active_tokens
                  ? `, ${c.active_tokens} live credential${c.active_tokens === 1 ? "" : "s"}`
                  : ""}
              </p>
            </div>
            <button
              type="button"
              disabled={pending}
              className="shrink-0 rounded-lg border border-red-300 px-3 py-1 text-xs font-medium text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-300"
              onClick={() =>
                startTransition(async () => {
                  const r = await revokeConnectionAction(c.client_id);
                  setMessage(
                    r.ok
                      ? `${c.client_name} was disconnected.`
                      : r.message ?? "Could not disconnect it."
                  );
                  router.refresh();
                })
              }
            >
              Disconnect
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
