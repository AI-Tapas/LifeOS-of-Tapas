// B31. The whole of POST /api/capture, with the database passed in so the
// offline suite can run it against an in-memory stand-in. The route file is a
// thin wrapper.
//
// A capture token can do exactly one thing: create a capture. It is looked up
// here and nowhere else, and no other token (the MCP bearer, a cron secret) is
// accepted. The database keeps only the sha256 of a token.

import {
  CAPTURE_PER_DAY,
  bearerToken,
  captureTitle,
  findRecentCapture,
  hashCaptureToken,
  hashesEqual,
  parseCaptureBody,
} from "./core.ts";
import { createTask } from "@/lib/tasks/write";
import { pickWorkStream } from "@/lib/tasks/stream";
import type { Database, Json } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface CaptureReply {
  status: number;
  body: { ok: boolean; task_id?: string; duplicate?: boolean; error?: string };
}

const fail = (status: number, error: string): CaptureReply => ({ status, body: { ok: false, error } });

export async function handleCapture(
  supabase: SupabaseClient<Database>,
  req: { authorization: string | null; body: string },
  nowMs: number = Date.now()
): Promise<CaptureReply> {
  const token = bearerToken(req.authorization);
  if (!token) return fail(401, "Unauthorized.");
  const hash = hashCaptureToken(token);
  const { data: row } = await supabase
    .from("capture_tokens")
    .select("id, user_id, token_hash")
    .eq("token_hash", hash)
    .maybeSingle();
  // Looked up by hash, then compared in constant time as well.
  if (!row || !hashesEqual(row.token_hash, hash)) return fail(401, "Unauthorized.");
  const userId = row.user_id;

  const parsed = parseCaptureBody(req.body);
  if (!parsed.ok) return fail(parsed.status, parsed.message);
  const { text } = parsed;

  const since = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  const { data: recent } = await supabase
    .from("tasks")
    .select("id, notes, created_at")
    .eq("user_id", userId)
    .eq("source", "capture")
    .gte("created_at", since);
  const dup = findRecentCapture(recent ?? [], text, nowMs);
  if (dup) return { status: 200, body: { ok: true, task_id: dup, duplicate: true } };
  if ((recent ?? []).length >= CAPTURE_PER_DAY) {
    return fail(429, `That is ${CAPTURE_PER_DAY} captures today. Try again tomorrow.`);
  }

  const { data: streams } = await supabase.from("work_streams").select("id, name").eq("user_id", userId);
  const stream = pickWorkStream(streams ?? [], null);
  if (!stream.ok) return fail(500, "Could not file the capture.");
  const created = await createTask(
    supabase,
    userId,
    {
      title: captureTitle(text),
      notes: text,
      status: "inbox",
      source: "capture",
      work_stream_id: stream.id,
      reminder_mode: "in_app",
    },
    "assistant"
  );
  if (!created.ok) return fail(500, "Could not save the capture.");

  // Bookkeeping that must never fail the save.
  await supabase.from("capture_tokens").update({ last_used_at: new Date(nowMs).toISOString() }).eq("id", row.id);
  await supabase.from("audit_log").insert({
    user_id: userId,
    actor: "user",
    action: "capture_created",
    entity: "tasks",
    entity_id: created.id,
    meta: { chars: text.length } as Json,
  });
  return { status: 200, body: { ok: true, task_id: created.id } };
}
