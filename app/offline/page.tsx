export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="text-center">
        <h1 className="font-serif text-2xl font-medium text-foreground">Offline</h1>
        <p className="mt-2 text-sm text-secondary">
          This page is not cached yet. Reconnect and try again.
        </p>
      </div>
    </main>
  );
}
