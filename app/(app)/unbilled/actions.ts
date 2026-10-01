"use server";

// Thin cookie-session wrapper over lib/billing/write.ts: his own marks only.
// NOTE: never re-export types from a "use server" module.

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/require-user";
import { setBillingState } from "@/lib/billing/write";
import type { BillingState } from "@/lib/billing/unbilled";

export async function setBillingStateAction(
  taskId: string,
  state: BillingState | null,
  ref: string | null
): Promise<{ ok: true; prev_state: BillingState | null; prev_ref: string | null } | { ok: false; message: string }> {
  const { supabase, user } = await requireUser("/unbilled");
  const r = await setBillingState(supabase, user.id, taskId, state, ref);
  if (!r.ok) return r;
  revalidatePath("/unbilled");
  revalidatePath("/tasks");
  return { ok: true, prev_state: r.prev.state, prev_ref: r.prev.ref };
}
