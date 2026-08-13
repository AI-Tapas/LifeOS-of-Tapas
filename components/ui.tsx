"use client";

// Small shared UI primitives used by the tasks and money screens. Mobile-first:
// forms open as a bottom sheet on a phone and a centred card on wider screens.

export const inputCls =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-base dark:border-neutral-700 dark:bg-neutral-900";

export const btnPrimary =
  "rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white active:bg-indigo-700 disabled:opacity-50";
export const btnGhost =
  "rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium active:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:active:bg-neutral-900";

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
        "rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 " +
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
        <h1 className="text-[22px] font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-neutral-500">{subtitle}</p>}
      </div>
      {action}
    </div>
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
      <span className="text-xs font-medium text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
      {children}
    </div>
  );
}

// Sticky footer for drawer forms: cancels the drawer's p-4 so it sits flush,
// and keeps its own padding above the home-indicator safe area.
export const drawerFooterCls =
  "sticky bottom-0 z-10 -mx-4 -mb-[max(1rem,env(safe-area-inset-bottom))] mt-3 border-t border-neutral-100 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] dark:border-neutral-900 dark:bg-neutral-950";

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
              "rounded-full border px-3 py-1.5 text-sm " +
              (selected
                ? "border-indigo-600 bg-indigo-600 text-white"
                : "border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300")
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
      <div className="relative z-50 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-neutral-200 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] dark:border-neutral-800 dark:bg-neutral-950 sm:rounded-2xl">
        <div className="sticky top-0 z-10 -mx-4 -mt-4 mb-2 flex items-center justify-between border-b border-neutral-100 bg-white px-4 py-3 dark:border-neutral-900 dark:bg-neutral-950">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="-m-2 p-2 text-sm font-medium text-neutral-500 dark:text-neutral-400"
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
