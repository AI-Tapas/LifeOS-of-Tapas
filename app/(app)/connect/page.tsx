// The same disclosure registry drives consent, Settings and MCP authorization.
// Keep this a server-rendered form so approval needs no client JavaScript.
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { clientCanAuthorize, redirectUriAllowed } from "@/lib/mcp/oauth-core";
import { CAPABILITY_DESCRIPTIONS } from "@/lib/mcp/permissions";
import { PageHeader } from "@/components/ui";
export const dynamic = "force-dynamic";
type Search = Record<string, string | string[] | undefined>;
function one(v: string | string[] | undefined): string { return (Array.isArray(v) ? v[0] : v) ?? ""; }
export default async function ConnectPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const clientId = one(sp.client_id), redirectUri = one(sp.redirect_uri), state = one(sp.state), challenge = one(sp.code_challenge);
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: client } = await createServiceClient().from("mcp_clients")
    .select("client_id, client_name, redirect_uris, revoked_at, approved_at, registration_expires_at")
    .eq("client_id", clientId).eq("user_id", user.id).maybeSingle();
  const problem = !client || !clientCanAuthorize(client) ? "That registration has expired or was disconnected. Start a new connection from your application."
    : !redirectUriAllowed(redirectUri, client.redirect_uris) ? "That return address was not registered by this application."
    : !/^[A-Za-z0-9_-]{43}$/.test(challenge) || state.length > 2048 ? "This request has an invalid security challenge." : null;
  if (problem) return <main><PageHeader title="Connection refused" /><p className="rounded-xl border border-overdue/30 bg-overdue-soft p-4 text-sm text-overdue">{problem} Nothing has been granted.</p></main>;
  const [{ data: accounts, error: accountError }, { data: streams, error: streamError }] = await Promise.all([
    supabase.from("accounts").select("slot, email").eq("user_id", user.id).order("slot"),
    supabase.from("work_streams").select("id, name").eq("user_id", user.id).order("name"),
  ]);
  if (accountError || streamError) return <main><PageHeader title="Connection unavailable" /><p role="alert">Your permission options could not be loaded. Reload this page to try again. Nothing has been granted.</p></main>;
  return <main>
    <PageHeader title="Connect an application" subtitle="Only approve this if you started it yourself, just now." />
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
      <p className="text-sm"><span className="text-secondary">Application:</span> <span className="font-medium">{client!.client_name}</span></p>
      <p className="mt-1 break-all text-sm"><span className="text-secondary">Returns to:</span> <span className="font-mono text-[13px]">{redirectUri}</span></p>
      <p className="mt-1 break-all text-xs text-secondary">Client id {clientId}</p>
      <form action="/api/mcp/oauth/approve" method="POST" className="mt-4 space-y-4">
        <input type="hidden" name="client_id" value={clientId} /><input type="hidden" name="redirect_uri" value={redirectUri} />
        <input type="hidden" name="state" value={state} /><input type="hidden" name="code_challenge" value={challenge} />
        <fieldset className="space-y-3 rounded-xl bg-surface-2 p-3"><legend className="font-medium">Choose permissions</legend>
          <p className="text-sm text-secondary">Everything is ticked so your agents keep full use of Life OS. Untick anything you want to withhold.</p>
          {(Object.entries(CAPABILITY_DESCRIPTIONS) as [keyof typeof CAPABILITY_DESCRIPTIONS, { label: string; description: string }][]).map(([key, info]) =>
            <label key={key} className="flex items-start gap-3 text-sm"><input className="mt-1" type="checkbox" name={key} defaultChecked required={key === "read"} /><span><span className="font-medium">{info.label}</span><span className="block text-secondary">{info.description}</span></span></label>)}
        </fieldset>
        <fieldset className="space-y-2 rounded-xl border border-border p-3 text-sm"><legend className="font-medium">Mailbox scope</legend>
          <label className="flex gap-2"><input type="radio" name="mailboxes_mode" value="all" defaultChecked />All connected mailboxes, including future ones</label>
          <label className="flex gap-2"><input type="radio" name="mailboxes_mode" value="selected" />Only the mailboxes checked below</label>
          {(accounts ?? []).filter((a) => a.slot).map((a) => <label className="ml-5 flex gap-2" key={a.slot}><input type="checkbox" name="mailboxes" value={a.slot!} />{a.email} ({a.slot})</label>)}
        </fieldset>
        <fieldset className="space-y-2 rounded-xl border border-border p-3 text-sm"><legend className="font-medium">Work stream scope</legend>
          <label className="flex gap-2"><input type="radio" name="work_streams_mode" value="all" defaultChecked />All work streams, including future ones</label>
          <label className="flex gap-2"><input type="radio" name="work_streams_mode" value="selected" />Only the work streams checked below</label>
          {(streams ?? []).map((s) => <label className="ml-5 flex gap-2" key={s.id}><input type="checkbox" name="work_streams" value={s.id} />{s.name}</label>)}
        </fieldset>
        <p className="text-sm text-secondary">Selecting specific mailboxes or work streams disables tools that cannot safely isolate those records, including combined context and search. An empty selection grants access to none of that group.</p>
        <p className="text-sm text-secondary">This connection cannot approve proposals, read provider secrets, or change these permissions. Sending mail and changes affecting calendar guests require your approval in Life OS. You can disconnect it in Settings. Approving again replaces its previous credentials.</p>
        <div className="flex flex-wrap gap-2"><button type="submit" className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white dark:text-neutral-950">Approve selected permissions</button><Link href="/" className="rounded-xl border border-border-strong px-4 py-2 text-sm font-medium">Cancel</Link></div>
      </form>
    </div>
  </main>;
}
