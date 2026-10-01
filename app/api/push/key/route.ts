// B31. Serves the VAPID PUBLIC key to the Settings page (owner session only).
// The private key and the subject never leave the server. With the keys
// missing it says so and nothing crashes.

import { createClient } from "@/lib/supabase/server";
import { vapidConfig } from "@/lib/push/send";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("not signed in", { status: 401 });
  const vapid = vapidConfig();
  return Response.json(
    vapid ? { configured: true, public_key: vapid.publicKey } : { configured: false },
    { headers: { "cache-control": "no-store" } }
  );
}
