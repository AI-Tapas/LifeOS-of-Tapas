import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PrintButton from "@/components/trips/print-button";
import BillSheet from "@/components/trips/bill-sheet";
import { parseLineItems } from "@/lib/trips/bill";

export const dynamic = "force-dynamic";

// The PDF, without a PDF library: a print stylesheet plus the browser's own
// "Save as PDF". Phone and laptop both produce a proper file from this.
export default async function BillPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: bill }, { data: profile }] = await Promise.all([
    supabase
      .from("bills")
      .select(
        "id, number, date, bill_to, bill_to_address, amount, status, line_items, trip_id, trips(title, start_date, end_date)"
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("billing_profile")
      .select("name, address, email, phone, footer")
      .maybeSingle(),
  ]);
  if (!bill) notFound();

  const trip = bill.trips as {
    title: string;
    start_date: string | null;
    end_date: string | null;
  } | null;
  const letterheadMissing = !profile?.name?.trim() && !profile?.address?.trim();

  return (
    <main>
      <div className="no-print mb-4 flex items-center justify-between gap-2">
        <Link
          href={bill.trip_id ? `/trips/${bill.trip_id}` : "/trips"}
          className="text-xs font-semibold text-secondary"
        >
          Back to trip
        </Link>
        <PrintButton />
      </div>

      {letterheadMissing && (
        <p className="no-print mb-4 rounded-xl border border-today/30 bg-today-soft p-3 text-xs text-today">
          Your name and address are empty. Settings, Bill letterhead, fills the
          top of this bill.
        </p>
      )}

      <BillSheet
        bill={{
          number: bill.number,
          date: bill.date,
          bill_to: bill.bill_to,
          bill_to_address: bill.bill_to_address,
          amount: Number(bill.amount),
          line_items: parseLineItems(bill.line_items),
          trip_title: trip?.title ?? null,
          trip_start: trip?.start_date ?? null,
          trip_end: trip?.end_date ?? null,
        }}
        letterhead={{
          name: profile?.name ?? "",
          address: profile?.address ?? "",
          email: profile?.email ?? null,
          phone: profile?.phone ?? null,
          footer: profile?.footer ?? null,
        }}
      />

      <p className="no-print mt-4 text-xs text-muted">
        Print, then choose Save as PDF. Save it where you keep your bills; the
        app records the bill number as its reference, never the file.
      </p>
    </main>
  );
}
