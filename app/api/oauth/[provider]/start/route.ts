import { NextResponse, type NextRequest } from "next/server";
import { slotByKey } from "@/lib/accounts";
import { clientConfig } from "@/lib/oauth/config";
import { buildAuthUrl } from "@/lib/oauth/providers";
import { randomUrlSafe, pkceChallenge } from "@/lib/oauth/core";

// Begins a connect (or reconnect) flow for one slot. Generates PKCE + state,
// stashes them in a short-lived httpOnly cookie, and redirects to the provider.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const slot = slotByKey(req.nextUrl.searchParams.get("slot"));
  if (!slot || slot.provider !== provider) {
    return NextResponse.redirect(new URL("/settings?error=bad_slot", req.url));
  }

  const state = randomUrlSafe();
  const verifier = randomUrlSafe(48);
  const challenge = await pkceChallenge(verifier);
  const cfg = clientConfig(slot.oauthClient, slot.scopes);
  const authUrl = buildAuthUrl(cfg, {
    state,
    codeChallenge: challenge,
    loginHint: slot.loginHint || undefined,
  });

  const res = NextResponse.redirect(authUrl);
  res.cookies.set("oauth_flow", JSON.stringify({ slot: slot.key, state, verifier }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
