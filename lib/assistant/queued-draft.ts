// B36: "Save to drafts" on a queued send_email. The owner chooses, in the app,
// to keep the words but not send them: the draft is created in the mailbox the
// mail would have gone from, and the queued action closes as saved_as_draft.
//
// Pure and dependency-injected (relative .ts imports only), like core.ts, so
// scripts/b36.test.ts proves it offline. Rules it keeps:
//   - Only a PROPOSED send_email can be saved to drafts; anything else is left.
//   - Nothing is sent. The only provider calls are the draft calls in
//     mailbox.ts, which has no path to a send endpoint.
//   - If the draft cannot be saved, the action stays proposed and the error is
//     shown, so nothing is lost.
//   - No MCP tool reaches this: it is called only by an owner server action.

import { saveNewDraft, type MailAccount, type MailRequest } from "./mailbox.ts";

export interface QueuedDraftDeps {
  loadAction(): Promise<{ id: string; kind: string; status: string; payload: unknown } | null>;
  account(accountId: string): Promise<MailAccount>;
  request(accountId: string): MailRequest;
  // Compare-and-swap proposed -> saved_as_draft. False when it lost the race.
  markSaved(result: Record<string, unknown>): Promise<boolean>;
  audit(meta: Record<string, unknown>): Promise<void>;
}

export type QueuedDraftOutcome = { ok: true; message: string } | { ok: false; message: string };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export async function saveQueuedToDrafts(deps: QueuedDraftDeps): Promise<QueuedDraftOutcome> {
  const action = await deps.loadAction();
  if (!action) return { ok: false, message: "Action not found." };
  if (action.kind !== "send_email") return { ok: false, message: "Only a queued email can be saved to drafts." };
  if (action.status !== "proposed") return { ok: false, message: `This action is already ${action.status}.` };
  const p = (action.payload ?? {}) as Record<string, unknown>;
  const accountId = typeof p.account_id === "string" ? p.account_id : "";
  if (!accountId) return { ok: false, message: "The action has no account bound to it." };

  let account: MailAccount;
  let saved: { draft_id: string; version: string };
  try {
    account = await deps.account(accountId);
    const request = deps.request(accountId);
    const body = typeof p.body === "string" ? p.body : "";
    const thread = typeof p.thread_id === "string" ? p.thread_id.trim() : "";
    // Exactly what Approve would send: the approved to, cc, subject and body,
    // in the thread when the payload carries one.
    saved = await saveNewDraft(request, account, {
      to: strings(p.to),
      cc: strings(p.cc),
      subject: typeof p.subject === "string" ? p.subject : "",
      body,
      ...(thread ? { thread_id: thread } : {}),
    });
  } catch (e) {
    const why = e instanceof Error ? e.message : "The draft could not be saved.";
    return { ok: false, message: `${why} The email is still in the queue.` };
  }

  const where = `Saved to drafts in ${account.slot}`;
  let closed = false;
  try {
    closed = await deps.markSaved({
      saved_as_draft: true,
      mailbox: account.slot,
      draft_id: saved.draft_id,
      version: saved.version,
      summary: where,
    });
  } catch {
    closed = false;
  }
  if (!closed) {
    return {
      ok: false,
      message: `A draft was saved in ${account.slot}, but the queue could not be updated. Check Drafts there before trying again so you do not get two.`,
    };
  }
  try {
    await deps.audit({ kind: "send_email", account_slot: account.slot, draft_id: saved.draft_id });
  } catch {
    return { ok: true, message: `${where}. The supplementary audit entry failed.` };
  }
  return { ok: true, message: where };
}
