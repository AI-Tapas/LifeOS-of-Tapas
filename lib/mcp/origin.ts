// The public origin of this deployment. Behind Vercel the request URL is the
// internal one, so the forwarded headers are authoritative; APP_BASE_URL wins
// when set, since that is what the OAuth redirect URIs were registered with.
// The origin the request actually arrived on, ignoring configuration. Used
// for same-origin checks, where the configured value would be wrong whenever
// the app is reached by another valid host (localhost, a preview deployment).
export function requestOrigin(req: Request): string {
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  if (!host) return "";
  const proto =
    req.headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

export function appOrigin(req: Request): string {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
  const proto =
    req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
