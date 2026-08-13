import { Card, PageHeader } from "@/components/ui";

export default function Placeholder({ title }: { title: string }) {
  return (
    <main>
      <PageHeader title={title} />
      <Card>
        <p className="text-sm text-neutral-500">
          This module arrives in a later milestone.
        </p>
      </Card>
    </main>
  );
}
