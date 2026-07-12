import { withResourceAuth } from "@/lib/oauth/tokens";
import { createServiceClient } from "@/lib/supabase/service";
import type { Provider } from "@/lib/accounts";

// Metadata only. Event contents are Milestone 3; this just lists the calendars
// an account exposes so the user can pick a write-back / reminder-home target.
// Resource calls go through withResourceAuth so a 401 from a provider-side
// revocation is turned into a refresh, then needs_reauth, not a raw 500.
interface RawCal {
  ext: string;
  name: string;
  color: string | null;
}

async function googleCalendars(accountId: string): Promise<RawCal[]> {
  const res = await withResourceAuth(accountId, (token) =>
    fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
      headers: { authorization: `Bearer ${token}` },
    })
  );
  if (!res.ok) throw new Error(`google calendarList ${res.status}`);
  const j = (await res.json()) as { items?: GoogleCalItem[] };
  return (j.items ?? []).map((c) => ({
    ext: c.id,
    name: c.summaryOverride ?? c.summary ?? c.id,
    color: c.backgroundColor ?? null,
  }));
}

async function microsoftCalendars(accountId: string): Promise<RawCal[]> {
  const res = await withResourceAuth(accountId, (token) =>
    fetch("https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,hexColor", {
      headers: { authorization: `Bearer ${token}` },
    })
  );
  if (!res.ok) throw new Error(`graph calendars ${res.status}`);
  const j = (await res.json()) as { value?: MsCalItem[] };
  return (j.value ?? []).map((c) => ({
    ext: c.id,
    name: c.name,
    color: c.hexColor && c.hexColor !== "auto" ? c.hexColor : null,
  }));
}

interface GoogleCalItem {
  id: string;
  summary?: string;
  summaryOverride?: string;
  backgroundColor?: string;
}
interface MsCalItem {
  id: string;
  name: string;
  hexColor?: string;
}

// Fetch the account's calendar list and upsert it into the calendars table.
// Existing write-back / reminder-home flags are preserved (not in the payload).
export async function syncCalendars(
  accountId: string,
  provider: Provider,
  userId: string
): Promise<number> {
  const cals =
    provider === "google"
      ? await googleCalendars(accountId)
      : await microsoftCalendars(accountId);

  if (cals.length === 0) return 0;

  const svc = createServiceClient();
  const { error } = await svc.from("calendars").upsert(
    cals.map((c) => ({
      user_id: userId,
      account_id: accountId,
      ext_calendar_id: c.ext,
      name: c.name,
      color: c.color,
    })),
    { onConflict: "account_id,ext_calendar_id" }
  );
  if (error) throw error;
  return cals.length;
}
