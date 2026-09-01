import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import AssistantChat from "@/components/assistant/chat";
import {
  PendingCard,
  HistoryRow,
  AuditList,
  type PendingView,
  type HistoryView,
  type AuditView,
  type RecipientFlag,
} from "@/components/assistant/queue";
import { formatDateTimeIST, formatDateIST } from "@/lib/datetime";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

const TABS = [
  { key: "chat", label: "Chat" },
  { key: "queue", label: "Queue" },
  { key: "history", label: "History" },
  { key: "audit", label: "Audit" },
] as const;

const UNDOABLE = new Set([
  "create_task",
  "update_task",
  "set_reminder",
  "add_note",
  "add_person",
  "add_obligation",
  "add_event_solo",
]);

interface SendPayload {
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  attendees?: { email: string; name?: string }[];
  date?: string;
  start_time?: string | null;
  end_time?: string | null;
  location?: string | null;
}

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab = TABS.some((t) => t.key === rawTab) ? (rawTab as string) : "chat";
  // ?ask= is a flag, not free text: it selects one of a fixed set of openers
  // and nothing from the URL is ever put in the box verbatim. The line is
  // typed into the input, not sent, so he opens the conversation himself.
  const rawAsk = Array.isArray(sp.ask) ? sp.ask[0] : sp.ask;
  const prefill = rawAsk === "priorities" ? "Review my task priorities" : undefined;

  const supabase = await createClient();
  const [{ data: pendingRows }, { data: historyRows }, { data: auditRows }, { data: accounts }, { data: people }, { data: sentBefore }] =
    await Promise.all([
      supabase
        .from("assistant_actions")
        .select("id, kind, title, payload, created_at, account_id")
        .eq("status", "proposed")
        .order("created_at"),
      supabase
        .from("assistant_actions")
        .select("id, kind, title, status, created_at, executed_at, undone_at, error, result")
        .in("status", ["executed", "failed", "rejected", "undone", "approved"])
        .order("created_at", { ascending: false })
        .limit(40),
      supabase
        .from("audit_log")
        .select("id, actor, action, entity, ts, meta")
        .order("ts", { ascending: false })
        .limit(50),
      supabase.from("accounts").select("id, slot, email"),
      supabase.from("people").select("emails, unverified"),
      supabase
        .from("assistant_actions")
        .select("payload")
        .eq("kind", "send_email")
        .eq("status", "executed")
        .limit(200),
    ]);

  // Ground-truth recipient flags (A5/A6): unverified person records and
  // first-time recipients are highlighted on every pending card.
  const unverifiedEmails = new Set<string>();
  for (const p of people ?? []) {
    if (p.unverified) for (const e of p.emails) unverifiedEmails.add(e.toLowerCase());
  }
  const mailedBefore = new Set<string>();
  for (const row of sentBefore ?? []) {
    const pl = row.payload as SendPayload | null;
    for (const e of [...(pl?.to ?? []), ...(pl?.cc ?? [])]) {
      mailedBefore.add(e.toLowerCase());
    }
  }
  const accountLabel = (id: string | null) => {
    const a = (accounts ?? []).find((x) => x.id === id);
    return a ? `${a.slot ?? "account"} (${a.email})` : "unknown account";
  };
  const flag = (email: string): RecipientFlag => {
    const e = email.toLowerCase();
    const flags: string[] = [];
    if (unverifiedEmails.has(e)) flags.push("unverified record");
    if (!mailedBefore.has(e)) flags.push("first send from here");
    return { email, flags };
  };

  const pending: PendingView[] = (pendingRows ?? []).map((row) => {
    const pl = (row.payload ?? {}) as SendPayload;
    const base = {
      id: row.id,
      kind: row.kind,
      title: row.title,
      created_at_label: formatDateTimeIST(row.created_at),
      account_label: accountLabel(row.account_id),
    };
    // A B10 downgrade: an autonomous tool whose target did not resolve. It ran
    // nothing, it is bound to no account, and its title is the reason.
    if (row.kind !== "send_email" && row.kind !== "propose_event_with_invites") {
      return { ...base, unresolved_reason: row.title };
    }
    if (row.kind === "send_email") {
      return {
        ...base,
        to: (pl.to ?? []).map(flag),
        cc: (pl.cc ?? []).map(flag),
        subject: pl.subject ?? "",
        body: pl.body ?? "",
      };
    }
    return {
      ...base,
      attendees: (pl.attendees ?? []).map((a) => flag(a.email)),
      subject: (pl as { title?: string }).title,
      event_line: [
        pl.date ? formatDateIST(`${pl.date}T00:00:00+05:30`) : "",
        pl.start_time ? `at ${pl.start_time}` : "",
        pl.location ? `in ${pl.location}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  });

  const history: HistoryView[] = (historyRows ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    when_label: formatDateTimeIST(row.executed_at ?? row.created_at),
    undoable:
      row.status === "executed" &&
      UNDOABLE.has(row.kind) &&
      !!(row.result as { undo?: unknown } | null)?.undo,
    error: row.error,
  }));

  const audit: AuditView[] = (auditRows ?? []).map((row) => {
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    const detail = [meta.kind, meta.slot, meta.reason]
      .filter((v) => typeof v === "string")
      .join(", ");
    return {
      id: row.id,
      ts_label: formatDateTimeIST(row.ts),
      actor: row.actor,
      action: row.action,
      entity: row.entity,
      detail,
    };
  });

  return (
    <main>
      <PageHeader
        title="Assistant"
        subtitle="Acts on its own for your private lists; asks before anything reaches another person."
      />

      <div className="mb-4 flex gap-1 rounded-xl border border-border bg-surface p-1">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === "chat" ? "/assistant" : `/assistant?tab=${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={
              "flex min-h-11 flex-1 items-center justify-center rounded-lg text-center text-sm font-medium " +
              (tab === t.key
                ? "bg-accent text-white dark:text-neutral-950"
                : "text-secondary")
            }
          >
            {t.label}
            {t.key === "queue" && pending.length > 0 && (
              <span
                className={
                  "ml-1.5 rounded-full px-1.5 text-[11px] font-semibold " +
                  (tab === t.key
                    ? "bg-white/25"
                    : "bg-waiting-soft text-waiting")
                }
              >
                {pending.length}
              </span>
            )}
          </Link>
        ))}
      </div>

      {tab === "chat" && <AssistantChat prefill={prefill} />}

      {tab === "queue" && (
        <div className="space-y-3">
          {pending.length === 0 && (
            <div className="rounded-xl border border-dashed border-border-strong p-6 text-center">
              <p className="text-sm font-semibold">Nothing waiting for approval.</p>
              <p className="mt-1 text-sm text-secondary">
                When the assistant drafts an email or an invite, it lands here
                first. Nothing leaves this app until you approve it on this
                screen.
              </p>
            </div>
          )}
          {pending.map((item) => (
            <PendingCard key={item.id} item={item} />
          ))}
        </div>
      )}

      {tab === "history" && (
        <div className="rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
          {history.length === 0 ? (
            <p className="text-sm text-secondary">No assistant actions yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {history.map((item) => (
                <HistoryRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "audit" && (
        <div className="rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
          <AuditList rows={audit} />
        </div>
      )}
    </main>
  );
}
