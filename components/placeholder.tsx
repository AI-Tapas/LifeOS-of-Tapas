export default function Placeholder({ title }: { title: string }) {
  return (
    <main>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-neutral-500">
        This module arrives in a later milestone.
      </p>
    </main>
  );
}
