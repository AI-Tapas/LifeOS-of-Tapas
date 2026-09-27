// B20 amendment. Text out of a ticket PDF, in memory, server-side.
//
// Used ONLY by the mail scan's ticket pass, for PDF attachments of mail from
// allowlisted ticket senders (scan-filters.ts isTicketSender). The text lives
// for the length of one model turn and is never stored: only the leg fields
// the model proposes (from, to, date, mode, ref) are written anywhere.
//
// unpdf (MIT, no dependencies) ships a serverless build of Mozilla's pdf.js,
// so it runs in a Vercel function and under node --test alike. No OCR: an
// image-only PDF yields no text and the caller falls back to the file name.

import { extractText, getDocumentProxy } from "unpdf";

export const PDF_TEXT_CAP = 6000;

export async function pdfText(bytes: Uint8Array): Promise<string> {
  // A file that does not start with the PDF signature is not read at all.
  if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return "";
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { text } = await extractText(pdf, { mergePages: true });
    return text.replace(/\s+/g, " ").trim().slice(0, PDF_TEXT_CAP);
  } finally {
    await pdf.cleanup();
  }
}
