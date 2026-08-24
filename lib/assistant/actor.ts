// Who an assistant action runs as. Two callers need different answers:
//
//   cookieActor()   the browser, carrying the owner's Supabase session. RLS
//                   applies, which is the normal path for the app UI.
//   serviceActor()  the MCP connector and any other server-to-server caller,
//                   which has no cookie. Authenticated by a shared token at
//                   the route boundary, then scoped here to the single owner
//                   account.
//
// Both return the same shape, so lib/assistant/execute.ts is identical for
// either: the autonomy buckets, the approval gate and the audit trail do not
// care how the caller proved who they are. Note that the service client
// bypasses RLS, so every query it makes must scope itself; this app has
// exactly one user, and the owner id below is resolved from the allow-listed
// sign-in address rather than trusted from the caller.

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { FORBIDDEN_EMAIL as OWNER_SIGN_IN_EMAIL } from "@/lib/accounts";
import type { Database } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Actor {
  supabase: SupabaseClient<Database>;
  userId: string;
}

export async function cookieActor(): Promise<Actor> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("not signed in");
  return { supabase, userId: user.id };
}

let cachedOwnerId: string | null = null;

export async function serviceActor(): Promise<Actor> {
  const supabase = createServiceClient();
  if (!cachedOwnerId) {
    const { data, error } = await supabase.auth.admin.listUsers({ perPage: 50 });
    if (error) throw new Error(`Could not resolve the owner account: ${error.message}`);
    const owner = data.users.find(
      (u) => (u.email ?? "").toLowerCase() === OWNER_SIGN_IN_EMAIL.toLowerCase()
    );
    if (!owner) throw new Error("The owner account does not exist yet.");
    cachedOwnerId = owner.id;
  }
  return { supabase, userId: cachedOwnerId };
}
