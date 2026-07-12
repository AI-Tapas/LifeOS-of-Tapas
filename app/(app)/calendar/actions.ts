"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { syncAllEvents } from "@/lib/events/sync";
import {
  createEvent,
  updateEvent,
  deleteAppEvent,
  ConfirmationRequiredError,
  ReadOnlyAccountError,
  type AppEventInput,
} from "@/lib/events/write";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("not signed in");
  return { supabase, user };
}

export type SyncResult = {
  ok: boolean;
  upserted: number;
  deleted: number;
  skipped: { slot: string | null; reason: string }[];
};

// On-demand sync of all connected accounts. Never throws to the render: each
// account reports its own outcome and a revoked account is a graceful skip.
export async function syncEventsAction(): Promise<SyncResult> {
  const { user } = await requireUser();
  try {
    const results = await syncAllEvents(user.id);
    revalidatePath("/calendar");
    const upserted = results.reduce((n, r) => n + r.upserted, 0);
    const deleted = results.reduce((n, r) => n + r.deleted, 0);
    const skipped = results
      .filter((r) => r.skipped || r.error)
      .map((r) => ({ slot: r.slot, reason: r.skipped ?? r.error ?? "skipped" }));
    return { ok: true, upserted, deleted, skipped };
  } catch {
    return { ok: false, upserted: 0, deleted: 0, skipped: [] };
  }
}

export type EventActionResult =
  | { ok: true; id: string }
  | { ok: false; needsConfirmation: true; attendeeCount: number }
  | { ok: false; message: string };

function toResult(e: unknown): EventActionResult {
  if (e instanceof ConfirmationRequiredError) {
    return { ok: false, needsConfirmation: true, attendeeCount: e.attendeeCount };
  }
  if (e instanceof ReadOnlyAccountError) return { ok: false, message: e.message };
  return { ok: false, message: e instanceof Error ? e.message : "Something went wrong." };
}

export async function createEventAction(
  accountId: string,
  input: AppEventInput,
  confirmed: boolean
): Promise<EventActionResult> {
  const { user } = await requireUser();
  try {
    const r = await createEvent(user.id, accountId, input, confirmed);
    revalidatePath("/calendar");
    return { ok: true, id: r.id };
  } catch (e) {
    return toResult(e);
  }
}

export async function updateEventAction(
  eventId: string,
  input: AppEventInput,
  confirmed: boolean
): Promise<EventActionResult> {
  const { user } = await requireUser();
  try {
    const r = await updateEvent(user.id, eventId, input, confirmed);
    revalidatePath("/calendar");
    return { ok: true, id: r.id };
  } catch (e) {
    return toResult(e);
  }
}

export async function deleteEventAction(
  eventId: string
): Promise<{ ok: boolean; message?: string }> {
  const { user } = await requireUser();
  try {
    await deleteAppEvent(user.id, eventId);
    revalidatePath("/calendar");
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not delete." };
  }
}
