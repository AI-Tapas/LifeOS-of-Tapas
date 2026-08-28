"use client";

import { btnPrimary } from "@/components/ui";

// The whole PDF path: the browser's own print dialog, which offers Save as
// PDF on the phone and the laptop alike. No PDF library ships in this app.
export default function PrintButton() {
  return (
    <button onClick={() => window.print()} className={btnPrimary}>
      Print or save as PDF
    </button>
  );
}
