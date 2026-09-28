// B20 amendment. Text out of a ticket PDF, in memory, server-side.
//
// Used by the mail scan's ticket and cab passes, for PDF attachments of mail
// from allowlisted senders (scan-filters.ts mayReadMailContent), and since B22
// by lifeos_read_mail_attachment, one named attachment Tapas or his agent
// asked for (lib/assistant/attachment.ts), with a larger cap. The text is
// never stored: the scan writes only the fields the model proposes, and the
// attachment tool hands the text back and writes only an audit row.
//
// unpdf (MIT, no dependencies) ships a serverless build of Mozilla's pdf.js,
// so it runs in a Vercel function and under node --test alike. No OCR: an
// image-only PDF yields no text and the caller falls back to the file name.

import { extractText, getDocumentProxy } from "unpdf";

export const PDF_TEXT_CAP = 6000;

export async function pdfText(bytes: Uint8Array, cap: number = PDF_TEXT_CAP): Promise<string> {
  // A file that does not start with the PDF signature is not read at all.
  if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return "";
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { text } = await extractText(pdf, { mergePages: true });
    return text.replace(/\s+/g, " ").trim().slice(0, cap);
  } finally {
    await pdf.cleanup();
  }
}
