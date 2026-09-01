// Reading and writing the chat thread (backlog B6). Server only.
//
// The rules live next door in chat-history.ts, pure and proven offline; this
// file is the I/O around them.
//
// Owner session only, every path. These functions take the cookie-scoped
// client, so RLS scopes them to him; the table's grants are revoked from
// service_role, so the connectors cannot reach it even though they bypass RLS.
// No tool calls anything here, and none may be added: the transcript is his
// own words about his own work, which puts it in the same class as the
// persona.

import { requireUser } from "@/lib/auth/require-user";
import type { Database } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  KEEP_TURNS,
  idsToTrim,
  sanitizeTurns,
  type ChatTool,
  type ChatTurn,
} from "./chat-history";

type Db = SupabaseClient<Database>;

// How far back a write is willing to look when trimming. Appends trim on every
// write, so the tail can only be long once, right after an import.
const TRIM_SCAN = 500;

// The newest KEEP_TURNS, oldest first. Bounded on purpose: a thread three
// years old must not turn the Assistant tab into a full-table read.
export async function loadChatTurns(supabase: Db): Promise<ChatTurn[]> {
  const { data } = await supabase
    .from("assistant_chat_turns")
    .select("role, content, tools")
    .order("seq", { ascending: false })
    .limit(KEEP_TURNS);
  const rows = (data ?? []).reverse();
  return rows.map((r) => {
    const tools = Array.isArray(r.tools) ? (r.tools as unknown as ChatTool[]) : [];
    return {
      role: r.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: r.content,
      ...(tools.length ? { tools } : {}),
    };
  });
}

async function trim(supabase: Db, userId: string): Promise<void> {
  const { data } = await supabase
    .from("assistant_chat_turns")
    .select("id")
    .order("seq", { ascending: false })
    .limit(TRIM_SCAN);
  const drop = idsToTrim((data ?? []).map((r) => r.id));
  if (!drop.length) return;
  // Deleted, not flagged. "New chat" and the trim both have to actually
  // remove the rows, or the thread is only hidden and still on the server.
  await supabase
    .from("assistant_chat_turns")
    .delete()
    .in("id", drop)
    .eq("user_id", userId);
}

// One exchange: his message and the reply, written together so a reply can
// never be stored without the question that produced it.
export async function appendChatTurns(turns: ChatTurn[]): Promise<void> {
  const clean = sanitizeTurns(turns);
  if (!clean.length) return;
  const { supabase, user } = await requireUser("/assistant");
  await supabase.from("assistant_chat_turns").insert(
    clean.map((t) => ({
      user_id: user.id,
      role: t.role,
      content: t.content,
      tools: (t.tools ?? []) as unknown as Database["public"]["Tables"]["assistant_chat_turns"]["Insert"]["tools"],
    }))
  );
  await trim(supabase, user.id);
}

export async function clearChatTurns(): Promise<void> {
  const { supabase, user } = await requireUser("/assistant");
  await supabase.from("assistant_chat_turns").delete().eq("user_id", user.id);
}

// The one-time move off localStorage. It only ever fills an EMPTY thread: if
// anything is already stored, the device's copy is stale and is dropped rather
// than merged, because merging two orderings of the same conversation produces
// a third conversation that never happened.
//
// Returns how many turns were taken, so the browser knows the move happened
// and can forget its own copy.
export async function importLocalChatTurns(raw: unknown): Promise<number> {
  const clean = sanitizeTurns(raw);
  if (!clean.length) return 0;
  const { supabase, user } = await requireUser("/assistant");
  const { count } = await supabase
    .from("assistant_chat_turns")
    .select("id", { count: "exact", head: true });
  if ((count ?? 0) > 0) return 0;
  await supabase.from("assistant_chat_turns").insert(
    clean.map((t) => ({
      user_id: user.id,
      role: t.role,
      content: t.content,
      tools: (t.tools ?? []) as unknown as Database["public"]["Tables"]["assistant_chat_turns"]["Insert"]["tools"],
    }))
  );
  return clean.length;
}
