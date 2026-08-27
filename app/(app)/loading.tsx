// Instant skeleton shown while any module page loads. Keeps every bottom-nav
// tap responsive even on a slow connection. motion-safe, not plain
// animate-pulse: a skeleton that breathes at someone who asked the OS for less
// motion is exactly what that setting is for.
export default function Loading() {
  return (
    <main
      className="motion-safe:animate-pulse"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="h-7 w-40 rounded-lg bg-border" />
      <div className="mt-6 space-y-3">
        <div className="h-16 rounded-xl bg-surface-2" />
        <div className="h-16 rounded-xl bg-surface-2" />
        <div className="h-16 rounded-xl bg-surface-2" />
        <div className="h-16 rounded-xl bg-surface-2" />
      </div>
    </main>
  );
}
