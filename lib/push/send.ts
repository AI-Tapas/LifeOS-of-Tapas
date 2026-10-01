// B31. Sends one alert to every device that turned phone alerts on.
//
// The caller passes its own Supabase client: the owner session (Settings test
// button), or the service client (connector, crons), which scopes itself by
// user_id. web-push does the RFC 8291 encryption and VAPID signing; nothing
// here is hand-rolled crypto.
//
// Rules, all pure in ./core.ts: quiet hours (10 PM to 7 AM IST, nothing is
// sent and nothing is queued), at most 20 alerts in a rolling 24 hours across
// every source, a 404 or 410 deletes that device, any other failure stamps
// last_error_at. The audit row (push_sent) carries counts only, never the text.

import webpush from "web-push";
import { alertsInWindow, isQuietHoursIST, overAlertCap, shapePush } from "./core.ts";
import type { Database, Json } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient<Database>;

export type PushStatus =
  | "sent"
  | "not_configured"
  | "quiet_hours"
  | "rate_limited"
  | "no_devices"
  | "error";

export interface PushResult {
  status: PushStatus;
  sent: number;
  failed: number;
  removed: number;
}

const none = (status: PushStatus): PushResult => ({ status, sent: 0, failed: 0, removed: 0 });

// The three server-only variables. Absent means alerts are simply not set up.
export function vapidConfig(): { subject: string; publicKey: string; privateKey: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { subject, publicKey, privateKey };
}

export interface SendOptions {
  // The Settings test button is Tapas holding the phone, so it may ring in
  // quiet hours. Nothing automatic ever sets this.
  ignoreQuietHours?: boolean;
  now?: Date;
}

export async function sendPush(
  supabase: Db,
  userId: string,
  message: { title: string; body: string; url?: string },
  opts: SendOptions = {}
): Promise<PushResult> {
  const vapid = vapidConfig();
  if (!vapid) return none("not_configured");
  const now = opts.now ?? new Date();
  if (!opts.ignoreQuietHours && isQuietHoursIST(now)) return none("quiet_hours");

  const { data: sentRows } = await supabase
    .from("audit_log")
    .select("ts")
    .eq("user_id", userId)
    .eq("action", "push_sent")
    .gte("ts", new Date(now.getTime() - 24 * 3600 * 1000).toISOString());
  if (overAlertCap(alertsInWindow(sentRows ?? [], now.getTime()))) return none("rate_limited");

  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", userId);
  if (!subs?.length) return none("no_devices");

  const payload = JSON.stringify(shapePush(message));
  const result: PushResult = { status: "sent", sent: 0, failed: 0, removed: 0 };
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 3600, urgency: "normal", vapidDetails: vapid }
      );
      result.sent += 1;
      await supabase
        .from("push_subscriptions")
        .update({ last_ok_at: now.toISOString() })
        .eq("id", sub.id);
    } catch (e) {
      const code = (e as { statusCode?: number } | null)?.statusCode;
      if (code === 404 || code === 410) {
        // The device is gone (app removed, alerts turned off): forget it.
        await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        result.removed += 1;
      } else {
        await supabase
          .from("push_subscriptions")
          .update({ last_error_at: now.toISOString() })
          .eq("id", sub.id);
        result.failed += 1;
      }
    }
  }
  if (result.sent === 0) result.status = "error";

  // Counts only. The words of an alert are never stored.
  await supabase.from("audit_log").insert({
    user_id: userId,
    actor: "assistant",
    action: "push_sent",
    entity: "push",
    meta: {
      devices: subs.length,
      sent: result.sent,
      failed: result.failed,
      removed: result.removed,
    } as Json,
  });
  return result;
}

// Best effort for the automatic sources (an agent result, the scan alarm): an
// alert that cannot be sent must never fail the thing that raised it.
export async function sendPushQuietly(
  supabase: Db,
  userId: string,
  message: { title: string; body: string; url?: string }
): Promise<PushResult> {
  try {
    return await sendPush(supabase, userId, message);
  } catch {
    return none("error");
  }
}
