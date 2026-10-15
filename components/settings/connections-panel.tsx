"use client";

// Settings > Connected applications. Shows every remote client that has been
// approved, and lets one be cut off. Revoking kills its live tokens and its
// access while retaining a revocation record; reconnecting requires consent.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { revokeConnectionAction } from "@/app/(app)/connect/actions";
import { CAPABILITY_DESCRIPTIONS, normalizeCapabilities } from "@/lib/mcp/permissions";
import { Empty } from "@/components/ui";

export interface ConnectionView {
  client_id: string;
  client_name: string;
  created_label: string;
  last_used_label: string | null;
  active_tokens: number;
  capabilities: unknown;
  approved: boolean;
  work_stream_labels: Record<string, string>;
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
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
      {message && <p role="status" className="mb-2 text-sm text-accent">{message}</p>}
      <ul className="divide-y divide-border">
        {items.map((c) => (
          <li
            key={c.client_id}
            className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <p className="font-medium">{c.client_name}</p>
              <p className="text-xs text-secondary">
                {c.approved ? "Connected" : "Registered"} {c.created_label}
                {c.last_used_label ? `, last used ${c.last_used_label}` : ", not used yet"}
                {c.active_tokens
                  ? `, ${c.active_tokens} live credential${c.active_tokens === 1 ? "" : "s"}`
                  : ""}
              </p>
              <ConnectionPermissions connection={c} />
            </div>
            <button
              type="button"
              disabled={pending}
              className="shrink-0 rounded-lg border border-overdue/40 px-3 py-1 text-xs font-medium text-overdue disabled:opacity-50"
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

function ConnectionPermissions({ connection }: { connection: ConnectionView }) {
  const capabilities = normalizeCapabilities(connection.capabilities);
  if (!connection.approved || !capabilities) {
    return <p className="mt-1 text-xs text-overdue">Reconnect from the application to review and approve its permissions. Access is paused.</p>;
  }
  const granted = Object.entries(CAPABILITY_DESCRIPTIONS).filter(([key]) => capabilities[key as keyof typeof CAPABILITY_DESCRIPTIONS]);
  return (
    <div className="mt-2 text-xs text-secondary">
      <p>Allowed: {granted.map(([key, value]) => key === "finance" && !capabilities.write ? "Read financial records" : value.label).join(", ") || "None"}.</p>
      <p className="mt-1">Mailboxes: {capabilities.mailboxes === null ? "All" : capabilities.mailboxes.join(", ") || "None"}.</p>
      <p className="mt-1">Work streams: {capabilities.work_streams === null ? "All" : capabilities.work_streams.map((id) => connection.work_stream_labels[id] ?? "Unavailable stream").join(", ") || "None"}.</p>
      <p className="mt-1">To change permissions, disconnect and reconnect from the application.</p>
    </div>
  );
}
