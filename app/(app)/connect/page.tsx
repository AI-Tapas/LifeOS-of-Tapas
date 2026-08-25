// Consent screen. The authorize endpoint has already checked that the client
// is registered, that the redirect address belongs to it, and that a signed-in
// owner is asking. Nothing is granted until the button below is pressed.
//
// It sits inside the (app) group deliberately, so the normal auth gate covers
// it: an unsigned visitor never reaches this page at all.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { redirectUriAllowed } from "@/lib/mcp/oauth-core";
import { PageHeader } from "@/components/ui";
import ConnectConsent from "@/components/settings/connect-consent";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const clientId = one(sp.client_id);
  const redirectUri = one(sp.redirect_uri);
  const state = one(sp.state);
  const codeChallenge = one(sp.code_challenge);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Re-check rather than trust the query string that reached this page.
  const svc = createServiceClient();
  const { data: client } = await svc
    .from("mcp_clients")
    .select("client_id, client_name, redirect_uris, created_at")
    .eq("client_id", clientId)
    .maybeSingle();

  const problem = !client
    ? "That application is not registered with Life OS."
    : !redirectUriAllowed(redirectUri, client.redirect_uris)
      ? "That return address was not registered by this application."
      : !codeChallenge
        ? "This request is missing its security challenge."
        : null;

  if (problem) {
    return (
      <main>
        <PageHeader title="Connection refused" />
        <p className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {problem} Nothing has been granted.
        </p>
      </main>
    );
  }

  return (
    <main>
      <PageHeader
        title="Connect an application"
        subtitle="Only approve this if you started it yourself, just now."
      />
      <ConnectConsent
        clientName={client!.client_name}
        clientId={clientId}
        redirectUri={redirectUri}
        state={state}
        codeChallenge={codeChallenge}
      />
    </main>
  );
}
