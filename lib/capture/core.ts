// B31. Share-to-Life OS: the pure rules. An Apple Shortcut posts text from the
// iOS share sheet to POST /api/capture with a capture token. The text becomes
// an inbox task with source "capture", which every surface fences as untrusted
// (it is often somebody else's WhatsApp message).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { duplicateScore, NEAR_DUPLICATE_THRESHOLD } from "../tasks/near-duplicate.ts";

export const CAPTURE_MAX_CHARS = 4000;
export const CAPTURE_TITLE_MAX = 120;
export const CAPTURE_PER_DAY = 60;
export const CAPTURE_DUP_WINDOW_MS = 10 * 60 * 1000;
// A body far beyond the text limit is refused before it is parsed.
export const CAPTURE_BODY_BYTES_MAX = 32 * 1024;
export const CAPTURE_TOKEN_PREFIX = "lo_cap_";
export const CAPTURE_TOKENS_MAX = 10;

export function newCaptureToken(): string {
  return CAPTURE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashCaptureToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function bearerToken(header: string | null): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec((header ?? "").trim());
  return m ? m[1] : null;
}

// Constant-time compare of two hex hashes.
export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type CaptureText = { ok: true; text: string } | { ok: false; status: number; message: string };

const SHAPE_HELP = 'The body must be JSON like {"text": "..."}.';

export function parseCaptureBody(raw: string): CaptureText {
  if (raw.length > CAPTURE_BODY_BYTES_MAX) {
    return { ok: false, status: 413, message: `Too large. Send at most ${CAPTURE_MAX_CHARS} characters of text.` };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, message: SHAPE_HELP };
  }
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string") return { ok: false, status: 400, message: SHAPE_HELP };
  if (!text.trim()) return { ok: false, status: 400, message: "There was no text to save." };
  if (text.length > CAPTURE_MAX_CHARS) {
    return { ok: false, status: 413, message: `That is ${text.length} characters; the limit is ${CAPTURE_MAX_CHARS}.` };
  }
  return { ok: true, text };
}

// The first non-empty line, one line, cut to 120 characters.
export function captureTitle(text: string): string {
  const first = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  return first.length <= CAPTURE_TITLE_MAX ? first : first.slice(0, CAPTURE_TITLE_MAX - 3).trimEnd() + "...";
}

// B19 near-duplicate rule, applied to the whole text: a repeat within 10
// minutes (a Shortcut run twice, a double tap) returns the task already made.
export function findRecentCapture(
  recent: { id: string; notes: string | null; created_at: string }[],
  text: string,
  nowMs: number
): string | null {
  for (const r of recent) {
    if (nowMs - Date.parse(r.created_at) > CAPTURE_DUP_WINDOW_MS) continue;
    const prior = r.notes ?? "";
    if (prior.trim().toLowerCase() === text.trim().toLowerCase()) return r.id;
    if (duplicateScore(prior, text) >= NEAR_DUPLICATE_THRESHOLD) return r.id;
  }
  return null;
}
