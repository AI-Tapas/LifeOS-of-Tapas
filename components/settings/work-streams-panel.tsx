"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { inputCls } from "@/components/ui";
import { formatINR } from "@/lib/datetime";
import { RATE_FLOOR } from "@/lib/money/rates";
import { setWorkStreamRateAction } from "@/app/(app)/settings/actions";

export interface WorkStreamView {
  id: string;
  name: string;
  kind: string;
  billing_entity: string | null;
  feeds_billing: boolean;
  hourly_rate: number | null;
  // B20: what mail belongs here, for the mail scan. At most 200 characters.
  scan_hint?: string | null;
}

const HINT_MAX = 200;

// The list Settings already showed, with one number added: what an hour of
// that stream is worth. Editing it is the whole feature. There is no quoting
// and no time tracking here, and nothing should be built on this without a
// decision of its own.
export default function WorkStreamsPanel({ streams }: { streams: WorkStreamView[] }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
      <ul className="divide-y divide-border">
        {streams.map((s) => (
          <StreamRow key={s.id} stream={s} />
        ))}
      </ul>
      <p className="mt-3 text-xs text-secondary">
        The assistant reads these. Where a stream has no rate it falls back to
        the {formatINR(RATE_FLOOR)} an hour floor in its rules and says so.
      </p>
    </div>
  );
}

function StreamRow({ stream }: { stream: WorkStreamView }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(
    stream.hourly_rate != null ? String(stream.hourly_rate) : ""
  );
  const [hint, setHint] = useState(stream.scan_hint ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setErr(null);
    const trimmed = value.trim();
    startTransition(async () => {
      const r = await setWorkStreamRateAction(
        stream.id,
        trimmed === "" ? null : Number(trimmed),
        hint.trim() === "" ? null : hint
      );
      if (r.ok) {
        setEditing(false);
        router.refresh();
      } else {
        setErr(r.message ?? "Could not save.");
      }
    });
  }

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{stream.name}</p>
          <p className="text-sm text-secondary">
            {stream.kind.replace(/_/g, " ")}
            {stream.billing_entity ? `, bills as ${stream.billing_entity}` : ""}
          </p>
        </div>
        <span className="shrink-0 text-xs text-muted">
          {stream.feeds_billing ? "billable" : "non-billing"}
        </span>
      </div>

      {editing ? (
        <div className="mt-2 space-y-2">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-secondary">
            What mail belongs here (the mail scan reads this). Leave it empty for none.
          </span>
          <input
            type="text"
            maxLength={HINT_MAX}
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            className={inputCls}
          />
          <span className="text-xs text-muted">
            {hint.length} of {HINT_MAX} characters
          </span>
        </label>
        <div className="flex items-end gap-2">
          <label className="block flex-1 space-y-1">
            <span className="text-xs font-medium text-secondary">
              Rate an hour (₹). Leave it empty for no rate.
            </span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className={inputCls}
            />
          </label>
          <button
            onClick={save}
            disabled={pending}
            className="press min-h-11 rounded-lg bg-accent px-3 text-sm font-medium text-white disabled:opacity-50 dark:text-neutral-950"
          >
            {pending ? "Saving" : "Save"}
          </button>
          <button
            onClick={() => {
              setEditing(false);
              setErr(null);
              setValue(stream.hourly_rate != null ? String(stream.hourly_rate) : "");
              setHint(stream.scan_hint ?? "");
            }}
            disabled={pending}
            className="press min-h-11 rounded-lg border border-border-strong px-3 text-sm font-medium disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
        </div>
      ) : (
        <>
          <button
            onClick={() => setEditing(true)}
            className="press mt-1 text-sm font-medium text-accent"
          >
            {stream.hourly_rate != null
              ? `${formatINR(stream.hourly_rate)} an hour`
              : "No rate recorded"}
          </button>
          <p className="mt-1 text-xs text-secondary">
            {stream.scan_hint ? `Mail scan: ${stream.scan_hint}` : "No mail scan hint"}
          </p>
        </>
      )}

      {err && <p className="mt-1 text-sm text-overdue">{err}</p>}
    </li>
  );
}
