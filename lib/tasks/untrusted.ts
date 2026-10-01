// B31. Which task sources carry text somebody else wrote. A scanned email is
// one; text shared from the iOS share sheet is the other (often a WhatsApp
// message from a stranger). Every surface that fences email-sourced task text
// as untrusted data asks THIS function, so the two cannot drift apart.
// Pure and import-free.

export const UNTRUSTED_TASK_SOURCES: readonly string[] = ["email", "capture"];

export function isUntrustedSource(source: string | null | undefined): boolean {
  return !!source && UNTRUSTED_TASK_SOURCES.includes(source);
}
