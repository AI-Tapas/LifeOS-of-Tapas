"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field, btnPrimary, inputCls } from "@/components/ui";
import { saveBillingProfileAction } from "@/app/(app)/settings/actions";

export interface BillingProfileView {
  name: string;
  address: string;
  email: string;
  phone: string;
  footer: string;
  bill_prefix: string;
}

export default function LetterheadPanel({
  profile,
}: {
  profile: BillingProfileView;
}) {
  const router = useRouter();
  const [f, setF] = useState<BillingProfileView>(profile);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setNote(null);
    startTransition(async () => {
      const r = await saveBillingProfileAction(f);
      setNote(r.ok ? "Saved." : (r.message ?? "Could not save."));
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
      <div className="space-y-3">
        <Field label="Name">
          <input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Address">
          <textarea
            value={f.address}
            onChange={(e) => setF({ ...f, address: e.target.value })}
            className={inputCls}
            rows={3}
          />
        </Field>
        <div className="flex gap-2">
          <Field label="Email">
            <input
              value={f.email}
              onChange={(e) => setF({ ...f, email: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="Phone">
            <input
              value={f.phone}
              onChange={(e) => setF({ ...f, phone: e.target.value })}
              className={inputCls}
            />
          </Field>
        </div>
        <Field label="Bill number prefix">
          <input
            value={f.bill_prefix}
            onChange={(e) => setF({ ...f, bill_prefix: e.target.value })}
            className={inputCls}
          />
        </Field>
        <p className="text-xs text-muted">
          Numbers run as prefix, financial year, serial: AICA/2026-27/001. The
          serial restarts every April.
        </p>
        <Field label="Footer (bank details, membership number)">
          <textarea
            value={f.footer}
            onChange={(e) => setF({ ...f, footer: e.target.value })}
            className={inputCls}
            rows={2}
          />
        </Field>

        <div className="flex items-center gap-3">
          <button onClick={save} disabled={pending} className={btnPrimary}>
            {pending ? "Saving" : "Save letterhead"}
          </button>
          {note && <span className="text-sm text-secondary">{note}</span>}
        </div>
      </div>
    </div>
  );
}
