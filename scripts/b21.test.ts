// B21 offline proof: cab receipts from Ola, Uber, Rapido and Bharat Taxi
// become billable expenses on AICA trips. Run: npm run test:b21
//
// Synthetic receipts only: no real names, addresses, phone numbers, booking
// ids or amounts.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CAB_RECEIPT_SENDERS,
  cabProviderOf,
  isCabReceiptSender,
  isNoiseMail,
  isTicketSender,
  mayReadMailContent,
  type CabProvider,
} from "../lib/assistant/scan-filters.ts";
import {
  CAB_RIDE_CAP,
  cabActionPayload,
  cabBriefLine,
  cabDescription,
  cabExpenseInput,
  cabReceiptMail,
  cleanArea,
  priorFromPayload,
  validateCabProposals,
  type CabTrip,
  type PriorCab,
} from "../lib/trips/cab.ts";
import { readTicketMail, type MailAccount, type MailRequest } from "../lib/assistant/mailbox.ts";
import { pdfText } from "../lib/assistant/pdf-text.ts";
import { buildCabUserMessage, CAB_SYSTEM, DATA_PREAMBLE } from "../lib/assistant/prompt.ts";
import { CAB_TOOL, disclosureOf } from "../lib/assistant/tools.ts";
import { isReceiptGap, receiptGaps, type MonthExpense } from "../lib/trips/month.ts";

const src = (rel: string) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");

// --- Fixtures ----------------------------------------------------------------

const TRIPS: CabTrip[] = [
  { id: "trip-kol", title: "AICA L1D2 Kolkata", cities: ["Kolkata"], start_date: "2026-10-12", end_date: "2026-10-14", legs: [] },
  { id: "trip-pune", title: "AICA Pune batch", cities: [], start_date: "2026-10-20", end_date: "2026-10-20", legs: [] },
];

const UBER_BODY =
  "Thanks for riding, Test. Total Rs 312.50. Trip date 12 Oct 2026, 21:05. " +
  "Pickup: Airport, Terminal 1. Drop: Hotel. Trip ID UBR-TEST-0001. Paid by card ending 0000.";
const OLA_PDF =
  "Ola Tax Invoice. CRN OLA0000001. Ride on 13 Oct 2026 at 08:40. From Hotel to ICAI Bhawan. " +
  "Total fare Rs 245. Driver TEST DRIVER.";
const RAPIDO_PDF =
  "Rapido Invoice. Ride ID RPD000001. 14 Oct 2026 18:10. Pickup ICAI Bhawan, Drop Airport. Amount Rs 180.";
const BHARAT_PDF =
  "Bharat Taxi Invoice 01 Oct 2026 to 31 Oct 2026. Ride 1: 12 Oct 2026 22:00 Airport to Hotel Rs 400. " +
  "Ride 2: 14 Oct 2026 19:30 Hotel to Airport Rs 420. Total Rs 820.";

const ACC: MailAccount = { id: "acc-1", slot: "ca_tapasnr", provider: "google", email: "owner@example.test" };
const b64 = (t: string) => Buffer.from(t).toString("base64url");

// A Gmail message with an optional text body and PDF parts; the injected
// extractor stands in for pdf.js by reading the fixture bytes back as text.
function gmailMock(body: string, parts: { filename: string; mimeType: string; size: number; text: string }[]) {
  const calls: string[] = [];
  const request: MailRequest = async (url) => {
    calls.push(url);
    const att = /\/attachments\/att(\d+)$/.exec(url);
    if (att) return new Response(JSON.stringify({ data: b64(parts[Number(att[1])].text) }));
    return new Response(
      JSON.stringify({
        id: "m1",
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "text/plain", body: { data: b64(body) } },
            ...parts.map((p, i) => ({ filename: p.filename, mimeType: p.mimeType, body: { size: p.size, attachmentId: `att${i}` } })),
          ],
        },
      })
    );
  };
  return { request, calls };
}
const fakeExtract = async (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

const call = (ref: string, provider: CabProvider, over: Record<string, unknown> = {}) => ({
  name: "propose_cab_expense",
  input: {
    external_ref: ref,
    provider,
    ride_date: "2026-10-12",
    ride_time: "21:05",
    from_area: "Airport",
    to_area: "Hotel",
    amount: 312.5,
    booking_id: "UBR-TEST-0001",
    ...over,
  },
});

// --- 1. Senders --------------------------------------------------------------

test("cab receipt senders: the four providers, subdomains included, and nothing that only looks like them", () => {
  assert.equal(cabProviderOf("Uber Receipts <noreply@uber.com>"), "uber");
  assert.equal(cabProviderOf("noreply@m.uber.com"), "uber");
  assert.equal(cabProviderOf("Ola <no-reply@olacabs.com>"), "ola");
  assert.equal(cabProviderOf("invoice@rapido.bike"), "rapido");
  assert.equal(cabProviderOf("noreply@rapido.co"), "rapido");
  assert.equal(cabProviderOf("Bharat Taxi <no-reply@bharattaxiapp.com>"), "bharat_taxi");
  // Bharat Taxi is one confirmed address, not the whole domain.
  assert.equal(cabProviderOf("sales@bharattaxiapp.com"), null);
  assert.equal(cabProviderOf("noreply@uber.com.evil.example"), null);
  assert.equal(cabProviderOf("noreply@notuber.com"), null);
  assert.ok(CAB_RECEIPT_SENDERS.some((s) => s.match === "no-reply@bharattaxiapp.com"));
  // A separate list from the ticket senders; both may be read, nothing else.
  assert.ok(!isTicketSender("noreply@uber.com"));
  assert.ok(mayReadMailContent("noreply@uber.com") && mayReadMailContent("traveldesk@icai.in"));
  assert.ok(!mayReadMailContent("clientco@example.com"));
});

test("cab receipts are taken out of the noise filter and never reach the task pass", () => {
  assert.equal(isNoiseMail({ from: "noreply@uber.com", subject: "Your Tuesday evening trip receipt" }), false);
  assert.equal(isNoiseMail({ from: "noreply@shop.example", subject: "Your receipt" }), true);
  const scan = src("lib/assistant/scan.ts");
  assert.ok(scan.includes("mails.filter((m) => !mayReadMailContent(m.from))"));
  assert.ok(isCabReceiptSender("no-reply@bharattaxiapp.com"));
});

test("a sender off the allowlist never has its body or attachments read", async () => {
  const { request, calls } = gmailMock("Ride receipt Rs 100", [
    { filename: "invoice.pdf", mimeType: "application/pdf", size: 10, text: OLA_PDF },
  ]);
  const read = await readTicketMail(request, ACC, { id: "m1", from: "rides@lookalike-cabs.example" }, fakeExtract);
  assert.equal(read.body, "");
  assert.deepEqual(read.attachments, []);
  assert.equal(calls.length, 0, "no provider call at all");
});

// --- 2. Reading and proposing -------------------------------------------------

test("an Uber body receipt, an Ola PDF and a Rapido PDF each give one expense on the matching trip", async () => {
  const uber = gmailMock(UBER_BODY, []);
  const ola = gmailMock("Please find your invoice attached.", [
    { filename: "Ola_Invoice.pdf", mimeType: "application/pdf", size: 40_000, text: OLA_PDF },
  ]);
  const rapido = gmailMock("Your ride invoice.", [
    { filename: "Rapido_Invoice.pdf", mimeType: "application/pdf", size: 30_000, text: RAPIDO_PDF },
  ]);
  const reads = [
    { ref: "gmail:ca_tapasnr:u1", from: "noreply@uber.com", r: await readTicketMail(uber.request, ACC, { id: "u1", from: "noreply@uber.com" }, fakeExtract) },
    { ref: "gmail:ca_tapasnr:o1", from: "no-reply@olacabs.com", r: await readTicketMail(ola.request, ACC, { id: "o1", from: "no-reply@olacabs.com" }, fakeExtract) },
    { ref: "gmail:ca_tapasnr:r1", from: "invoice@rapido.bike", r: await readTicketMail(rapido.request, ACC, { id: "r1", from: "invoice@rapido.bike" }, fakeExtract) },
  ];
  const mails = reads.map((x) => cabReceiptMail({ ref: x.ref, from: x.from, subject: "Receipt", date: "d" }, x.r));
  // Uber: the body is the receipt. Ola and Rapido: the PDF is, and the
  // covering note is left out.
  assert.ok(mails[0].body.includes("UBR-TEST-0001"));
  assert.equal(mails[0].attachments.length, 0);
  assert.equal(mails[1].body, "");
  assert.ok(mails[1].attachments[0].text!.includes("OLA0000001"));
  assert.ok(mails[2].attachments[0].text!.includes("RPD000001"));
  const msg = buildCabUserMessage(mails);
  assert.ok(msg.indexOf(DATA_PREAMBLE) < msg.indexOf("UBR-TEST-0001"), "fenced as untrusted data");

  const senders = new Map(reads.map((x) => [x.ref, cabProviderOf(x.from)!]));
  const r = validateCabProposals(
    [
      call("gmail:ca_tapasnr:u1", "uber"),
      call("gmail:ca_tapasnr:o1", "ola", { ride_date: "2026-10-13", ride_time: "08:40", from_area: "Hotel", to_area: "ICAI Bhawan", amount: 245, booking_id: "OLA0000001" }),
      call("gmail:ca_tapasnr:r1", "rapido", { ride_date: "2026-10-14", ride_time: "18:10", from_area: "ICAI Bhawan", to_area: "Airport", amount: 180, booking_id: "RPD000001" }),
    ],
    senders,
    TRIPS
  );
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.accepted.map((a) => [a.trip_id, a.provider, a.amount]), [
    ["trip-kol", "uber", 312.5],
    ["trip-kol", "ola", 245],
    ["trip-kol", "rapido", 180],
  ]);
  const input = cabExpenseInput(r.accepted[0]);
  assert.deepEqual(input, {
    trip_id: "trip-kol",
    category: "transport",
    amount: 312.5,
    date: "2026-10-12",
    billable: true,
    receipt_ref: "email:gmail:ca_tapasnr:u1",
  });
  assert.equal(cabDescription(r.accepted[0]), "Uber, Airport to Hotel");
  assert.equal(r.accepted[0].trip_label, "Kolkata");
});

test("a real PDF receipt is read by the B20 extractor", async () => {
  const content = "BT /F1 12 Tf 50 750 Td (Ola CRN OLA0000001 13 Oct 2026 08:40 Hotel to ICAI Bhawan Rs 245) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const text = await pdfText(new TextEncoder().encode(out));
  assert.ok(text.includes("OLA0000001 13 Oct 2026 08:40"), text);
});

test("Bharat Taxi: one expense per ride listed, each with its own date; unsplittable counts, never a lump", () => {
  const ref = "gmail:ca_tapasnr:b1";
  const senders = new Map<string, CabProvider>([[ref, "bharat_taxi"]]);
  const r = validateCabProposals(
    [
      call(ref, "bharat_taxi", { ride_date: "2026-10-12", ride_time: "22:00", amount: 400, booking_id: "" }),
      call(ref, "bharat_taxi", { ride_date: "2026-10-14", ride_time: "19:30", from_area: "Hotel", to_area: "Airport", amount: 420, booking_id: "" }),
    ],
    senders,
    TRIPS
  );
  assert.deepEqual(r.accepted.map((a) => [a.date, a.amount]), [["2026-10-12", 400], ["2026-10-14", 420]]);
  assert.ok(r.wellFormedRefs.has(ref));
  // Nothing proposed (the rides could not be told apart): the scan counts it.
  const none = validateCabProposals([], senders, TRIPS);
  assert.ok(!none.wellFormedRefs.has(ref));
  assert.ok(src("lib/assistant/scan.ts").includes('provider === "bharat_taxi" && !wellFormedRefs.has(ref)'));
  assert.match(CAB_SYSTEM, /never the invoice total as one ride/);
  assert.ok(BHARAT_PDF.includes("Total Rs 820"));
  assert.equal(
    cabBriefLine([], 1),
    "1 Bharat Taxi receipt could not be split into rides, so nothing was added from it."
  );
});

test("the sender decides the provider, and malformed rides are refused", () => {
  const senders = new Map<string, CabProvider>([["gmail:x:1", "uber"]]);
  const r = validateCabProposals(
    [
      call("gmail:x:1", "ola"),
      call("gmail:x:1", "uber", { ride_time: "9pm" }),
      call("gmail:x:1", "uber", { amount: 0 }),
      call("gmail:x:2", "uber"),
      { name: "propose_task", input: {} },
    ],
    senders,
    TRIPS
  );
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected.length, 5);
});

test("areas never carry a street address, pin code or phone number", () => {
  assert.equal(cleanArea("Airport, Terminal 1, Kolkata 700052"), "Airport");
  assert.equal(cleanArea("14 Park Street 700016"), null);
  assert.equal(cleanArea("9800000000"), null);
  assert.equal(cleanArea("  Hotel  "), "Hotel");
  assert.equal(cleanArea(""), null);
});

// --- 3. Trips, personal rides and duplicates ----------------------------------

test("a ride 3 days outside any trip stores nothing, and is only counted", () => {
  const senders = new Map<string, CabProvider>([["gmail:x:1", "uber"]]);
  const r = validateCabProposals([call("gmail:x:1", "uber", { ride_date: "2026-10-17" })], senders, TRIPS);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.personal, 1);
  assert.deepEqual(r.rejected, [], "no reason text, so nothing about the ride is kept");
  // A day either side of the trip still counts.
  const edge = validateCabProposals([call("gmail:x:1", "uber", { ride_date: "2026-10-15" })], senders, TRIPS);
  assert.equal(edge.accepted.length, 1);
  // The audit row carries the count, and the brief never mentions personal rides.
  const scan = src("lib/assistant/scan.ts");
  assert.ok(scan.includes("cab_rides_personal: cabs.personal"));
  assert.ok(!src("app/api/cron/brief/route.ts").includes("cab_rides_personal"));
  assert.equal(cabBriefLine([], 0), null);
});

test("a duplicate booking id is refused, and so is the same amount within 10 minutes", () => {
  const senders = new Map<string, CabProvider>([["gmail:x:1", "uber"], ["gmail:x:2", "uber"]]);
  const prior: PriorCab[] = [
    { trip_id: "trip-kol", provider: "uber", booking_id: "UBR-TEST-0001", amount: 312.5, date: "2026-10-12", time: "21:05" },
  ];
  // Same booking id, different amount and time.
  const a = validateCabProposals([call("gmail:x:2", "uber", { amount: 99, ride_time: "23:00" })], senders, TRIPS, prior);
  assert.equal(a.accepted.length, 0);
  // Same amount 8 minutes later, no booking id.
  const b = validateCabProposals([call("gmail:x:2", "uber", { booking_id: "", ride_time: "21:13" })], senders, TRIPS, prior);
  assert.equal(b.accepted.length, 0);
  // Same amount 11 minutes later is a different ride.
  const c = validateCabProposals([call("gmail:x:2", "uber", { booking_id: "", ride_time: "21:16" })], senders, TRIPS, prior);
  assert.equal(c.accepted.length, 1);
  // Twice in one run.
  const d = validateCabProposals([call("gmail:x:1", "uber"), call("gmail:x:2", "uber")], senders, TRIPS);
  assert.equal(d.accepted.length, 1);
  // What the action row keeps round-trips into the next night's check.
  assert.deepEqual(priorFromPayload(cabActionPayload(d.accepted[0])), prior[0]);
});

test("the nightly cap of 20 holds", () => {
  const senders = new Map<string, CabProvider>([["gmail:x:1", "ola"]]);
  const calls = Array.from({ length: 25 }, (_, i) =>
    call("gmail:x:1", "ola", { booking_id: `OLA-T-${i}`, ride_time: `${String(8 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`, amount: 100 + i })
  );
  const r = validateCabProposals(calls, senders, TRIPS);
  assert.equal(CAB_RIDE_CAP, 20);
  assert.equal(r.accepted.length, 20);
  assert.equal(r.rejected.filter((x) => x.includes("cap of 20")).length, 5);
  assert.ok(src("lib/assistant/scan.ts").includes("let cabBudget = CAB_RIDE_CAP;"));
});

// --- 4. Write, undo, audit ----------------------------------------------------

test("each ride writes through the add_trip_expense performer with its own action row, and undo removes the expense", () => {
  const exec = src("lib/assistant/execute.ts");
  const start = exec.indexOf("export async function logScannedCabExpense");
  const fn = exec.slice(start, exec.indexOf("\n}\n", start));
  assert.ok(fn.includes("performers.add_trip_expense("));
  assert.ok(fn.includes('kind: "add_trip_expense"'));
  assert.ok(fn.includes("result: { undo: done.undo }"));
  // The performer's undo is { expense_id }, and the undo case deletes exactly that.
  const perf = exec.slice(exec.indexOf("async add_trip_expense("), exec.indexOf("async add_event_solo("));
  assert.ok(perf.includes("undo: { expense_id: r.id }"));
  const undoCase = exec.slice(exec.indexOf('case "add_trip_expense": {'), exec.indexOf('case "save_reply_draft": {'));
  assert.ok(undoCase.includes("deleteTripExpense(supabase, userId, String(undo.expense_id))"));
});

test("the cab pass is isolated: one tool, and no receipt text in the audit row", () => {
  assert.equal(CAB_TOOL.name, "propose_cab_expense");
  assert.equal(disclosureOf("propose_cab_expense"), "app_data");
  for (const [k, v] of Object.entries(CAB_TOOL.input_schema.properties as Record<string, { type?: unknown; anyOf?: unknown }>)) {
    assert.equal(typeof v.type, "string", `${k} has one concrete type`);
    assert.equal(v.anyOf, undefined);
  }
  const scan = src("lib/assistant/scan.ts");
  assert.ok(scan.includes("tools: [CAB_TOOL]"));
  const meta = scan.slice(scan.indexOf('action: "mail_scan"'), scan.indexOf("provenance: provenance("));
  for (const leak of ["body", "subject", "booking", "from_area", "to_area", "snippet", "driver"]) {
    assert.ok(!meta.includes(leak), `audit meta must not carry ${leak}`);
  }
  // The action row keeps the expense fields only.
  const stored = cabActionPayload({
    trip_id: "t", trip_label: "Kolkata", external_ref: "r", provider: "uber", from_area: "Airport",
    to_area: "Hotel", amount: 1, date: "2026-10-12", time: "10:00", booking_id: "B",
  });
  assert.deepEqual(Object.keys(stored).sort(), ["amount", "booking_id", "date", "external_ref", "provider", "time", "trip_id", "via"]);
});

// --- 5. Brief and month pack ----------------------------------------------------

test("the brief says one line per trip with the rupee total", () => {
  assert.equal(
    cabBriefLine([
      { label: "Kolkata", count: 3, amount: 820 },
      { label: "Kolkata", count: 1, amount: 420 },
    ]),
    "4 cab receipts added to the Kolkata trip (Rs 1,240)."
  );
  assert.equal(
    cabBriefLine([{ label: "Kolkata", count: 1, amount: 245 }, { label: "AICA Pune batch", count: 2, amount: 125000 }]),
    "1 cab receipt added to the Kolkata trip (Rs 245); 2 cab receipts added to the AICA Pune batch trip (Rs 1,25,000)."
  );
  const brief = src("app/api/cron/brief/route.ts");
  assert.ok(brief.includes("cabBriefLine(cabAdded, cabUnsplit)"));
});

test("the month pack counts a ride with receipt_ref as having a receipt", () => {
  const ride: MonthExpense = {
    id: "e1", trip_id: "trip-kol", category: "transport", amount: 312.5, date: "2026-10-12", billable: true,
    receipt_ref: "email:gmail:ca_tapasnr:u1",
  };
  const bare: MonthExpense = { ...ride, id: "e2", receipt_ref: null };
  assert.equal(isReceiptGap(ride), false);
  assert.deepEqual(receiptGaps([ride, bare], ["2026-10"]).map((e) => e.id), ["e2"]);
});

test("the rulebook names both allowlists and no other sender", () => {
  const rules = src("CLAUDE.md");
  assert.match(rules, /ticket and cab-receipt allowlists/);
  assert.match(rules, /27 September 2026/);
});
