// A rate per work stream (backlog B4).
//
// The Rs 3,500 per hour floor lived only as a sentence in the assistant's hard
// rules, which asked a language model to remember a number. Now the app holds
// one number per stream and says it in the context, so the underpricing
// warning can name the stream's own rate instead of a remembered general one.
//
// This is the whole feature. There is no quoting, no invoicing and no time
// tracking here, and none should be built on top of this without a decision of
// its own: his invoicing already works, out of his own workbook (see the
// billing section of CLAUDE.md).
//
// Pure, so scripts/m7b.test.ts can prove the line the model actually reads.
import { formatINR } from "../datetime.ts";

// The floor from his own hard rules, used only where a stream records nothing
// of its own. Kept here beside the rates so the two cannot drift.
export const RATE_FLOOR = 3500;

export interface StreamRate {
  name: string;
  hourly_rate: number | null;
  active: boolean;
}

// The work-streams line in the assistant's app context. A stream with no rate
// says so plainly rather than being given the floor silently: "no rate
// recorded" is a fact the model can repeat back and he can correct, whereas a
// quietly assumed number is one he would never see.
export function streamRateLine(streams: StreamRate[]): string {
  const active = streams.filter((s) => s.active);
  if (!active.length) return "Work streams: none";
  const parts = active.map((s) =>
    typeof s.hourly_rate === "number"
      ? `${s.name} (${formatINR(s.hourly_rate)} an hour)`
      : `${s.name} (no rate recorded)`
  );
  return (
    "Work streams, with the rate an hour of each is worth: " +
    parts.join(", ") +
    `. Use a stream's own rate when you warn him about underpricing. Where a stream records no rate, the ${formatINR(RATE_FLOOR)} an hour floor in your rules applies.`
  );
}

// ponytail: no belowRate() helper. Judging a quote is the assistant's job and
// it now has the number; a comparison function with one caller in a prompt is
// code nothing runs.
