// The printable bill itself: letterhead, payer, line items, total in figures
// and in words. Presentational only, so the same markup serves the real page
// and the local visual harness.
//
// Everything it prints comes from data: the letterhead is an editable
// settings record, so no name, address or bank detail is hardcoded here.

import { formatINR } from "@/lib/datetime";
import {
  amountInWordsIndian,
  dayLabel,
  type BillLineItem,
} from "@/lib/trips/bill";

export interface Letterhead {
  name: string;
  address: string;
  email: string | null;
  phone: string | null;
  footer: string | null;
}

export interface BillSheetData {
  number: string;
  date: string;
  bill_to: string;
  bill_to_address: string | null;
  amount: number;
  line_items: BillLineItem[];
  trip_title: string | null;
  trip_start: string | null;
  trip_end: string | null;
}

export default function BillSheet({
  bill,
  letterhead,
}: {
  bill: BillSheetData;
  letterhead: Letterhead;
}) {
  const contact = [letterhead.email, letterhead.phone].filter(Boolean).join(" · ");
  return (
    <div className="print-sheet rounded-2xl border border-border bg-surface p-6 shadow-[var(--shadow-card)]">
      <header className="border-b border-border-strong pb-4">
        <h1 className="font-serif text-[26px] font-medium leading-tight">
          {letterhead.name || "Your name"}
        </h1>
        {letterhead.address && (
          <p className="mt-1 whitespace-pre-wrap text-sm text-secondary">
            {letterhead.address}
          </p>
        )}
        {contact && <p className="mt-1 text-sm text-secondary">{contact}</p>}
      </header>

      <div className="mt-5 flex flex-wrap justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted">
            Bill to
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm">
            {bill.bill_to_address || `The ${bill.bill_to}`}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted">
            Bill
          </p>
          <p className="mt-1 text-sm font-medium">{bill.number}</p>
          <p className="text-sm text-secondary">{dayLabel(bill.date)}</p>
        </div>
      </div>

      {bill.trip_title && (
        <p className="mt-5 text-sm">
          Reimbursement of travel expenses for {bill.trip_title}
          {bill.trip_start
            ? `, ${dayLabel(bill.trip_start)}${
                bill.trip_end && bill.trip_end !== bill.trip_start
                  ? ` to ${dayLabel(bill.trip_end)}`
                  : ""
              }`
            : ""}
          .
        </p>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border-strong text-left">
              <th className="py-2 pr-3 font-semibold">Date</th>
              <th className="py-2 pr-3 font-semibold">Description</th>
              <th className="py-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {bill.line_items.map((it, i) => (
              <tr key={i} className="border-b border-border align-top">
                <td className="whitespace-nowrap py-2 pr-3">{dayLabel(it.date)}</td>
                <td className="py-2 pr-3">{it.description}</td>
                <td className="whitespace-nowrap py-2 text-right">
                  {formatINR(it.amount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="py-3 pr-3 font-semibold" colSpan={2}>
                Total
              </td>
              <td className="whitespace-nowrap py-3 text-right text-base font-semibold">
                {formatINR(bill.amount)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="mt-1 text-sm text-secondary">{amountInWordsIndian(bill.amount)}</p>

      {letterhead.footer && (
        <p className="mt-6 whitespace-pre-wrap border-t border-border pt-4 text-sm text-secondary">
          {letterhead.footer}
        </p>
      )}

      <div className="mt-10">
        <p className="text-sm">{letterhead.name}</p>
        <p className="text-xs text-muted">Signature</p>
      </div>
    </div>
  );
}
