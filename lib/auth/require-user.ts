// One owner-session guard for every server action.
//
// Each action file used to keep its own copy that did `throw new Error("not
// signed in")`. Supabase access tokens expire, so this fires in ordinary use:
// leave a tab open past the token's life, press any button, and the throw
// escapes the action uncaught. In production Next reports that as "An error
// occurred in the Server Components render", with the real message withheld,
// which tells the user nothing and loses whatever they were doing.
//
// An expired session is not an error, it is a fact with an obvious remedy, so
// this sends them to sign in and come back to the page they were on. Actions
// keep exactly the same security property: no session, no action.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/database.types";
import type { SupabaseClient, User } from "@supabase/supabase-js";

export interface OwnerSession {
  supabase: SupabaseClient<Database>;
  user: User;
}

export async function requireUser(returnTo?: string): Promise<OwnerSession> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // redirect() never returns: it throws the framework's own signal, which
  // Next handles rather than reporting as a crash.
  if (!user) {
    redirect(returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : "/login");
  }
  return { supabase, user };
}
