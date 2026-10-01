// web-push ships no types and @types/web-push is not a dependency of this
// app, so the three calls lib/push/send.ts makes are declared here.
declare module "web-push" {
  interface PushSubscriptionLike {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }
  interface SendOptions {
    TTL?: number;
    urgency?: "very-low" | "low" | "normal" | "high";
    vapidDetails?: { subject: string; publicKey: string; privateKey: string };
  }
  export function sendNotification(
    subscription: PushSubscriptionLike,
    payload?: string,
    options?: SendOptions
  ): Promise<{ statusCode: number }>;
  const webpush: { sendNotification: typeof sendNotification };
  export default webpush;
}
