"use client";

// Small shared UI primitives used across screens. Mobile-first: forms open as
// a bottom sheet on a phone and a centred card on wider screens. Interactive
// controls keep a minimum 44px hit target, and .press gives them uniform
// touch feedback that respects reduced-motion.

import { useEffect, useState } from "react";

import { formatDateShortIST, istDayKey } from "@/lib/datetime";

export const inputCls =
  "w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-base";

export const btnPrimary =
  "press min-h-11 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover active:opacity-90 disabled:opacity-50 dark:text-neutral-950";
export const btnGhost =
  "press min-h-11 rounded-xl border border-border-strong px-4 py-2 text-sm font-medium active:bg-surface-2 disabled:opacity-50";
// Small in-card action, still a 44px target.
export const btnSmall =
  "press min-h-11 rounded-lg border border-border-strong px-3 text-xs font-medium disabled:opacity-50";

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={
        "rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)] " +
        className
      }
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <h1 className="font-serif text-[30px] font-medium leading-tight tracking-tight text-foreground">
          {title}
        </h1>
        {subtitle && <p className="mt-0.5 text-sm text-secondary">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

// Uppercase section eyebrow: one consistent voice for every list heading.
export function SectionLabel({
  children,
  tone = "",
  className = "",
}: {
  children: React.ReactNode;
  tone?: string; // e.g. "text-overdue"; default muted
  className?: string;
}) {
  return (
    <h3
      className={
        "text-[11px] font-bold uppercase tracking-wider " +
        (tone || "text-muted") +
        " " +
        className
      }
    >
      {children}
    </h3>
  );
}

// A count that jumps from 3 to 2 reads as a rendering glitch; a count that
// hands over reads as the app agreeing with you. The old value leaves upward
// while the new one arrives from below, in one 120ms beat. The outgoing value
// is absolutely positioned, so nothing around it moves. The handover is
// derived during render, not in an effect, so the new value never paints once
// before it animates.
export function Rolling({
  value,
  className = "",
}: {
  value: string | number;
  className?: string;
}) {
  const [shown, setShown] = useState<{
    cur: string | number;
    out: string | number | null;
  }>({ cur: value, out: null });
  if (shown.cur !== value) setShown({ cur: value, out: shown.cur });

  useEffect(() => {
    if (shown.out === null) return;
    const t = setTimeout(() => setShown((s) => ({ ...s, out: null })), 200);
    return () => clearTimeout(t);
  }, [shown.out]);

  return (
    <span className={"relative inline-block tabular-nums " + className}>
      {shown.out !== null && (
        <span
          key={`out-${shown.out}`}
          className="roll-out absolute inset-0 text-center"
          aria-hidden
        >
          {shown.out}
        </span>
      )}
      <span
        key={`cur-${value}`}
        className={"inline-block " + (shown.out !== null ? "roll-in" : "")}
      >
        {value}
      </span>
    </span>
  );
}

// Serif title, hairline rule, trailing count or action: the one band-header
// look shared by Home's bands and today's-shape, and Tasks overview's bands.
export function BandHead({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2.5">
      <h2 className="font-serif text-[19px] font-medium leading-none tracking-tight text-foreground">
        {title}
      </h2>
      <div className="h-px flex-1 bg-border" aria-hidden />
      {action !== undefined
        ? action
        : count !== undefined && (
            <Rolling
              value={count}
              className="text-[11px] font-bold leading-none text-muted"
            />
          )}
    </div>
  );
}

// Due-state chip: colour is the meaning. Overdue red, due today amber,
// everything else a quiet date. A missing date is called out (the starved
// state) only when flagMissing says it matters, so low-priority undated tasks
// stay quiet.
export function DueBadge({
  dueTs,
  nowIso,
  flagMissing = true,
}: {
  dueTs: string | null;
  nowIso: string;
  flagMissing?: boolean;
}) {
  if (!dueTs) {
    if (!flagMissing) return null;
    return (
      <span className="shrink-0 rounded-full bg-waiting-soft px-2.5 py-1 text-[11px] font-semibold text-waiting">
        no deadline
      </span>
    );
  }
  const overdue = dueTs < nowIso && istDayKey(dueTs) !== istDayKey(nowIso);
  const today = istDayKey(dueTs) === istDayKey(nowIso);
  if (overdue) {
    return (
      <span className="shrink-0 rounded-full bg-overdue-soft px-2.5 py-1 text-[11px] font-semibold text-overdue">
        overdue
      </span>
    );
  }
  if (today) {
    return (
      <span className="shrink-0 rounded-full bg-today-soft px-2.5 py-1 text-[11px] font-semibold text-today">
        today
      </span>
    );
  }
  return (
    <span className="shrink-0 text-[11px] text-secondary">
      {formatDateShortIST(dueTs)}
    </span>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-secondary">{label}</span>
      {children}
    </label>
  );
}

// Empty states teach: a short bold line about what lives here, then how to
// fill it. Old single-child call sites still render fine.
export function Empty({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border-strong p-6 text-center">
      {title && <p className="text-sm font-semibold">{title}</p>}
      <p className={"text-sm text-secondary " + (title ? "mt-1" : "")}>{children}</p>
    </div>
  );
}

// Sticky footer for drawer forms: cancels the drawer's p-4 so it sits flush,
// and keeps its own padding above the home-indicator safe area.
export const drawerFooterCls =
  "sticky bottom-0 z-10 -mx-4 -mb-[max(1rem,env(safe-area-inset-bottom))] mt-3 border-t border-border bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]";

// Toggle chips for reminder offsets (days before due). Fixed choices.
const REMIND_CHOICES = [0, 1, 3, 7, 14, 28];

export function RemindChips({
  value,
  onChange,
}: {
  value: number[];
  onChange: (v: number[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {REMIND_CHOICES.map((d) => {
        const selected = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={selected}
            onClick={() =>
              onChange(selected ? value.filter((x) => x !== d) : [...value, d])
            }
            className={
              "press min-h-11 rounded-full border px-3.5 text-sm " +
              (selected
                ? "border-accent bg-accent text-white dark:text-neutral-950"
                : "border-border-strong text-secondary")
            }
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}

export function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="rise-in relative z-50 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-border bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:rounded-2xl">
        <div className="sticky top-0 z-10 -mx-4 -mt-4 mb-2 flex items-center justify-between border-b border-border bg-surface px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="-m-2 min-h-11 p-2 text-sm font-medium text-muted"
            aria-label="Close"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
