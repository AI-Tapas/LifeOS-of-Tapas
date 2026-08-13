"use client";

// Small shared UI primitives used by the tasks and money screens. Mobile-first:
// forms open as a bottom sheet on a phone and a centred card on wider screens.

export const inputCls =
  "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

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
      <div className="relative z-50 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950 sm:rounded-2xl">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-500">{title}</h2>
          <button onClick={onClose} className="text-neutral-400" aria-label="Close">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
