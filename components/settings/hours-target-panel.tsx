"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { inputCls } from "@/components/ui";
import { setMonthlyHoursTargetAction } from "@/app/(app)/settings/actions";

// B32. One number: billable hours a month. Hours only, no amount.
export default function HoursTargetPanel({ target }: { target: number }) {
  const router = useRouter();
  const [value, setValue] = useState(String(target));
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setMsg(null);
    startTransition(async () => {
      const r = await setMonthlyHoursTargetAction(Number(value));
      setMsg(r.ok ? "Saved." : (r.message ?? "Could not save."));
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
      <label className="block space-y-1">
        <span className="text-xs font-medium text-secondary">Hours a month</span>
        <input
          type="number"
          min={1}
          max={400}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={inputCls}
        />
      </label>
      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={save}
          disabled={pending}
          className="press min-h-11 rounded-lg bg-accent px-3 text-sm font-medium text-white disabled:opacity-50 dark:text-neutral-950"
        >
          {pending ? "Saving" : "Save"}
        </button>
        {msg && <span className="text-sm text-secondary">{msg}</span>}
      </div>
    </div>
  );
}
