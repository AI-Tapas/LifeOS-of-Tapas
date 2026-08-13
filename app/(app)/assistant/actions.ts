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
