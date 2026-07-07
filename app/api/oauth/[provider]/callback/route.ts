import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { slotByKey, verifySlotEmail } from "@/lib/accounts";
import { clientConfig } from "@/lib/oauth/config";
import { exchangeCode } from "@/lib/oauth/providers";
import { decodeJwtPayload } from "@/lib/oauth/core";
import { syncCalendars } from "@/lib/calendars";

interface Flow {
  slot: string;
  state: string;
  verifier: string;
}

// Redirect back to Settings with a status, always clearing the flow cookie.
function back(req: NextRequest, q: Record<string, string>): NextResponse {
  const url = new URL("/settings", req.url);
  for (const [k, v] of Object.entries(q)) if (v) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  res.cookies.set("oauth_flow", "", { path: "/", maxAge: 0 });
  return res;
}

async function microsoftEmail(token: string): Promise<string> {
  try {
    const r = await fetch(
      "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
      { headers: { authorization: `Bearer ${token}` } }
    );
    if (!r.ok) return "";
    const j = (await r.json()) as { mail?: string; userPrincipalName?: string };
    return (j.mail ?? j.userPrincipalName ?? "").toLowerCase();
  } catch {
    return "";
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const sp = req.nextUrl.searchParams;

  let flow: Flow | null = null;
  const raw = req.cookies.get("oauth_flow")?.value;
  if (raw) {
    try {
      flow = JSON.parse(raw) as Flow;
    } catch {
      flow = null;
    }
  }
  const slot = slotByKey(flow?.slot);

  // Provider returned an error (icai.org admin block is the expected case).
  const provErr = sp.get("error");
  if (provErr) {
    if (slot?.allowForwarded) return back(req, { slot: slot.key, blocked: "1" });
    return back(req, { error: provErr, slot: slot?.key ?? "" });
  }

  if (!flow || !slot) return back(req, { error: "no_flow" });

  const code = sp.get("code");
  const state = sp.get("state");
  if (!code || !state || state !== flow.state) {
    return back(req, { error: "bad_state", slot: slot.key });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return back(req, { error: "not_signed_in", slot: slot.key });

  const cfg = clientConfig(slot.oauthClient, slot.scopes);
  let tok;
  try {
    tok = await exchangeCode(cfg, code, flow.verifier);
  } catch {
    return back(req, { error: "exchange_failed", slot: slot.key });
  }

  // Determine the connected email to verify against the slot.
  let email = "";
  if (tok.idToken) {
    try {
      const p = decodeJwtPayload(tok.idToken) as {
        email?: string;
        preferred_username?: string;
      };
      email = (p.email ?? p.preferred_username ?? "").toLowerCase();
    } catch {
      email = "";
    }
  }
  if (!email && provider === "microsoft") {
    email = await microsoftEmail(tok.accessToken);
  }
  if (!email) return back(req, { error: "no_email", slot: slot.key });

  const check = verifySlotEmail(slot, email);
  if (!check.ok) {
    return back(req, {
      error: "wrong_account",
      slot: slot.key,
      detail: check.reason ?? "",
    });
  }

  const scopes = tok.scope ? tok.scope.split(" ").filter(Boolean) : slot.scopes;
  const svc = createServiceClient();

  // Distinguish a reconnect (recovery from needs_reauth) from a first connect
  // in the audit log.
  const { data: prior } = await svc
    .from("accounts")
    .select("status")
    .eq("user_id", user.id)
    .eq("slot", slot.key)
    .maybeSingle();
  const isReconnect = prior?.status === "needs_reauth";

  const { data: acct, error: upErr } = await svc
    .from("accounts")
    .upsert(
      {
        user_id: user.id,
        slot: slot.key,
        provider: slot.provider,
        email,
        oauth_client: slot.oauthClient,
        scopes,
        connect_mode: "direct",
        status: "connected",
      },
      { onConflict: "user_id,slot" }
    )
    .select("id")
    .single();
  if (upErr || !acct) {
    return back(req, {
      error: "save_failed",
      slot: slot.key,
      detail: upErr?.message ?? "",
    });
  }

  await svc.rpc("set_account_tokens", {
    p_account_id: acct.id,
    p_refresh: tok.refreshToken ?? undefined,
    p_access: tok.accessToken,
    p_access_expires: tok.expiresAt,
  });

  await svc.from("audit_log").insert({
    user_id: user.id,
    actor: "user",
    action: isReconnect ? "oauth_reconnected" : "oauth_connected",
    entity: "accounts",
    entity_id: acct.id,
    meta: { slot: slot.key, email, scopes },
  });

  // Calendar list is best-effort; a failure here should not undo the connect.
  let calWarn = "";
  try {
    await syncCalendars(acct.id, slot.provider, user.id);
  } catch {
    calWarn = "calendars_failed";
  }

  return back(req, { connected: slot.key, cal_warn: calWarn });
}
