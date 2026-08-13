// Instant skeleton shown while any module page loads. Keeps every bottom-nav
// tap responsive even on a slow connection.
export default function Loading() {
  return (
    <main className="animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="h-7 w-40 rounded-lg bg-neutral-200 dark:bg-neutral-800" />
      <div className="mt-6 space-y-3">
        <div className="h-16 rounded-xl bg-neutral-100 dark:bg-neutral-900" />
        <div className="h-16 rounded-xl bg-neutral-100 dark:bg-neutral-900" />
        <div className="h-16 rounded-xl bg-neutral-100 dark:bg-neutral-900" />
        <div className="h-16 rounded-xl bg-neutral-100 dark:bg-neutral-900" />
      </div>
    </main>
  );
}
