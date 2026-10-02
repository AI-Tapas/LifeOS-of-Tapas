"use client";

import { formatHours } from "@/lib/hours/parse";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, Empty, SectionLabel, btnGhost, btnPrimary, inputCls } from "@/components/ui";
import { setBillingStateAction } from "@/app/(app)/unbilled/actions";
import { REF_MAX, type BillingState, type UnbilledGroup } from "@/lib/billing/unbilled";

// The list of finished work with no invoice yet. No amounts anywhere: Life OS
// records which work is billable and where its billing stands, nothing more.
// "Invoiced" asks for an optional reference (the Zoho number) and so does not
// fire on a stray tap.

interface Undo {
  task_id: string;
  title: string;
  label: string;
  state: BillingState | null;
  ref: string | null;
}

export default function UnbilledView({ groups }: { groups: UnbilledGroup[] }) {
  const router = useRouter();
  const [asking, setAsking] = useState<string | null>(null);
  const [ref, setRef] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [pending, startTransition] = useTransition();

  function mark(id: string, title: string, state: BillingState | null, refValue: string | null, label: string) {
    setErr(null);
    startTransition(async () => {
      const r = await setBillingStateAction(id, state, refValue);
      if (!r.ok) {
        setErr(r.message);
        return;
      }
      setAsking(null);
      setRef("");
      setUndo({ task_id: id, title, label, state: r.prev_state, ref: r.prev_ref });
      router.refresh();
    });
  }

  function undoLast() {
    if (!undo) return;
    const u = undo;
    setErr(null);
    startTransition(async () => {
      const r = await setBillingStateAction(u.task_id, u.state, u.ref);
      if (!r.ok) {
        setErr(r.message);
        return;
      }
      setUndo(null);
      router.refresh();
    });
  }

  const taskCount = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="space-y-6">
      {undo && (
        <Card className="flex items-center justify-between gap-3">
          <p className="text-sm">
            {undo.label}: {undo.title}
          </p>
          <button onClick={undoLast} disabled={pending} className={btnGhost}>
            Undo
          </button>
        </Card>
      )}
      {err && <p className="text-sm text-overdue">{err}</p>}
      {taskCount === 0 && (
        <Empty title="Nothing unbilled">
          Tick a client work stream as billable in Settings and its finished tasks appear here until you mark them invoiced.
        </Empty>
      )}
      {groups.map((g) => (
        <section key={g.stream}>
          <SectionLabel>
            {g.stream} ({g.rows.length})
          </SectionLabel>
          <ul className="mt-2 space-y-2">
            {g.rows.map((r) => (
              <li key={r.id}>
                <Card>
                  <p className="font-medium">{r.title}</p>
                  <p className="mt-0.5 text-sm text-secondary">
                    {r.project ? `${r.project}, ` : ""}finished {r.completed}, {r.days_since}{" "}
                    {r.days_since === 1 ? "day" : "days"} ago
                    {r.hours_spent != null ? `, ${formatHours(r.hours_spent)} h` : ""}
                  </p>
                  {r.billing_state === "estimate_drafted" && (
                    <p className="mt-1 text-sm text-waiting">
                      Estimate drafted{r.billing_ref ? `, ref ${r.billing_ref}` : ""}
                    </p>
                  )}
                  {asking === r.id ? (
                    <div className="mt-3 space-y-2">
                      <label className="block space-y-1">
                        <span className="text-xs font-medium text-secondary">
                          Zoho invoice number (optional)
                        </span>
                        <input
                          type="text"
                          maxLength={REF_MAX}
                          value={ref}
                          onChange={(e) => setRef(e.target.value)}
                          className={inputCls}
                        />
                      </label>
                      <div className="flex gap-2">
                        <button
                          onClick={() => mark(r.id, r.title, "invoiced", ref, "Marked invoiced")}
                          disabled={pending}
                          className={btnPrimary}
                        >
                          {pending ? "Saving" : "Mark invoiced"}
                        </button>
                        <button onClick={() => setAsking(null)} disabled={pending} className={btnGhost}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => {
                          setAsking(r.id);
                          setRef(r.billing_ref ?? "");
                        }}
                        disabled={pending}
                        className={btnPrimary}
                      >
                        Invoiced
                      </button>
                      <button
                        onClick={() => mark(r.id, r.title, "not_billable", null, "Marked not billable")}
                        disabled={pending}
                        className={btnGhost}
                      >
                        Not billable
                      </button>
                    </div>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
