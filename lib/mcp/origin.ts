// The public origin of this deployment. Behind Vercel the request URL is the
// internal one, so the forwarded headers are authoritative; APP_BASE_URL wins
// when set, since that is what the OAuth redirect URIs were registered with.
export function appOrigin(req: Request): string {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
  const proto =
    req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
