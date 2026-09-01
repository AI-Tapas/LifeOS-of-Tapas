"use server";

// Owner-session server actions for the assistant queue. Approval happens
// HERE and only here: the model has no tool that can reach these, and the
// executor refuses anything that did not pass through approveAndExecute.

import { revalidatePath } from "next/cache";
import {
  approveAndExecute,
  rejectProposedAction,
  undoExecutedAction,
} from "@/lib/assistant/execute";
import { runMailScan, type ScanSummary } from "@/lib/assistant/scan";
import {
  appendChatTurns,
  clearChatTurns,
  importLocalChatTurns,
} from "@/lib/assistant/chat-store";
import type { ChatTurn } from "@/lib/assistant/chat-history";

export type ActionResult = { ok: boolean; message?: string };

export async function approveActionAction(actionId: string): Promise<ActionResult> {
  const r = await approveAndExecute(actionId);
  revalidatePath("/assistant");
  return r;
}

export async function rejectActionAction(actionId: string): Promise<ActionResult> {
  const r = await rejectProposedAction(actionId);
  revalidatePath("/assistant");
  return r;
}

export async function undoActionAction(actionId: string): Promise<ActionResult> {
  const r = await undoExecutedAction(actionId);
  revalidatePath("/assistant");
  return r;
}

// ---------------------------------------------------------------------------
// The chat thread (B6). Owner session only, like everything else here.
// ---------------------------------------------------------------------------

export async function saveChatTurnsAction(turns: ChatTurn[]): Promise<ActionResult> {
  try {
    await appendChatTurns(turns);
    return { ok: true };
  } catch (e) {
    // A thread that fails to save must not break the conversation on screen.
    return { ok: false, message: e instanceof Error ? e.message : "Could not save." };
  }
}

export async function clearChatAction(): Promise<ActionResult> {
  try {
    await clearChatTurns();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not clear." };
  }
}

// Called once by the browser when it still holds an old localStorage thread.
// The count coming back is what tells it to forget its copy.
export async function importChatFromDeviceAction(
  raw: unknown
): Promise<{ ok: boolean; imported: number }> {
  try {
    return { ok: true, imported: await importLocalChatTurns(raw) };
  } catch {
    return { ok: false, imported: 0 };
  }
}

export async function scanMailAction(): Promise<
  { ok: true; summary: ScanSummary } | { ok: false; message: string }
> {
  try {
    const summary = await runMailScan();
    revalidatePath("/assistant");
    revalidatePath("/tasks");
    return { ok: true, summary };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "The mail scan failed.",
    };
  }
}
