import { createClient } from "@/lib/supabase/server";
import { formatDateTimeIST } from "@/lib/datetime";
import Link from "next/link";

// Metadata only, through the owner's RLS session. Never render tool inputs,
// message bodies, credentials or operation result snapshots here.
export default async function ConnectorActivity() {
  const db = await createClient();
  const [activity, jobs, operations] = await Promise.all([
    db.from("mcp_activity").select("id,client_id,tool,state,created_at").order("created_at", { ascending: false }).limit(20),
    db.from("mcp_jobs").select("id,client_id,state,created_at,cancel_requested").order("created_at", { ascending: false }).limit(10),
    db.from("mcp_operations").select("id,client_id,tool,state,created_at").in("state", ["running", "uncertain"]).order("created_at", { ascending: false }).limit(10),
  ]);
  if (activity.error || jobs.error || operations.error) return <p role="status" className="mt-3 text-sm text-overdue">Connector activity is temporarily unavailable. Refresh to try again.</p>;
  const label = (client: string) => client === "shared-secret" ? "Desktop shared connection" : client;
  return (
    <details className="mt-3 rounded-xl border border-border bg-surface p-4">
      <summary className="cursor-pointer text-sm font-medium">Recent connector activity and scan jobs</summary>
      <p className="mt-2 text-xs text-secondary">Activity shows tool names and outcomes only. Running or uncertain work may have changed records; check History and the connected account before repeating it.</p>
      {!!operations.data?.length && (
        <div className="mt-3">
          <h3 className="text-sm font-medium">Operations to check</h3>
          <ul className="divide-y divide-border">
            {operations.data.map(row => <li key={row.id} className="py-2 text-xs"><p>{row.tool}: <span className="text-waiting">{row.state}</span></p><p className="break-all text-secondary">{label(row.client_id)} · {formatDateTimeIST(row.created_at)} · {row.id}</p></li>)}
          </ul>
          <Link href="/assistant?tab=history" className="inline-block py-2 text-sm text-accent underline">Open action history</Link>
        </div>
      )}
      <h3 className="mt-3 text-sm font-medium">Scan jobs</h3>
      {!jobs.data?.length ? <p className="mt-1 text-xs text-secondary">No connector scan jobs yet.</p> : <ul className="divide-y divide-border">{jobs.data.map(row => <li key={row.id} className="py-2 text-xs"><p>{row.state}{row.cancel_requested ? ", cancellation requested" : ""} · {formatDateTimeIST(row.created_at)}</p><p className="break-all text-secondary">{label(row.client_id)} · {row.id}</p></li>)}</ul>}
      <h3 className="mt-3 text-sm font-medium">Latest calls</h3>
      {!activity.data?.length ? <p className="mt-1 text-xs text-secondary">No connector calls recorded yet.</p> : <ul className="divide-y divide-border">{activity.data.map(row => <li key={row.id} className="py-2 text-xs"><p>{row.tool}: {row.state}</p><p className="break-all text-secondary">{label(row.client_id)} · {formatDateTimeIST(row.created_at)}</p></li>)}</ul>}
    </details>
  );
}
