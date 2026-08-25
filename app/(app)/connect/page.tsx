// Consent screen. Deliberately a plain server-rendered form: approval must not
// depend on client-side JavaScript, since a hydration failure would otherwise
// leave the owner staring at an error page with nothing granted.
//
// Everything shown here is re-checked by the POST handler, so the query string
// that reached this page is treated as a claim, never as permission.

import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { redirectUriAllowed } from "@/lib/mcp/oauth-core";
import { PageHeader } from "@/components/ui";

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

  const svc = createServiceClient();
  const { data: client } = await svc
    .from("mcp_clients")
    .select("client_id, client_name, redirect_uris")
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

      <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <p className="text-sm">
          <span className="text-neutral-500">Application:</span>{" "}
          <span className="font-medium">{client!.client_name}</span>
        </p>
        <p className="mt-1 break-all text-sm">
          <span className="text-neutral-500">Returns to:</span>{" "}
          <span className="font-mono text-[13px]">{redirectUri}</span>
        </p>
        <p className="mt-1 text-xs text-neutral-400">Client id {clientId}</p>

        <div className="mt-3 rounded-xl bg-neutral-50 p-3 text-sm dark:bg-neutral-950">
          <p className="font-medium">If you approve, this application can:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-neutral-600 dark:text-neutral-300">
            <li>read your tasks, calendar and assistant context</li>
            <li>create tasks, reminders, notes, people and solo calendar events</li>
            <li>write email drafts and queue emails or invitations</li>
          </ul>
          <p className="mt-2 font-medium">It cannot:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-neutral-600 dark:text-neutral-300">
            <li>send any email or invitation: those still wait for you here</li>
            <li>approve anything in the queue, or read your persona or accounts</li>
          </ul>
        </div>

        <form action="/api/mcp/oauth/approve" method="POST" className="mt-4 flex gap-2">
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="redirect_uri" value={redirectUri} />
          <input type="hidden" name="state" value={state} />
          <input type="hidden" name="code_challenge" value={codeChallenge} />
          <button
            type="submit"
            className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white dark:text-neutral-950 "
          >
            Approve and connect
          </button>
          <Link
            href="/"
            className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
          >
            Cancel
          </Link>
        </form>
      </div>
    </main>
  );
}
