import type { ClientConfig } from "@/lib/oauth/providers";
import type { OauthClientId, Provider } from "@/lib/accounts";

// Server-only: reads OAuth client credentials from env. Two Google clients are
// mandatory (an Internal client cannot serve accounts outside its org): the
// internal one serves Tax Strategia, the external one serves the consumer and
// icai.org accounts. Microsoft is a single-tenant Entra app.

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function baseUrl(): string {
  return reqEnv("APP_BASE_URL").replace(/\/$/, "");
}

// One redirect URI per provider; both Google clients register the same string.
export function redirectUri(provider: Provider): string {
  return `${baseUrl()}/api/oauth/${provider}/callback`;
}

export function clientConfig(
  client: OauthClientId,
  scopes: string[]
): ClientConfig {
  switch (client) {
    case "google_internal":
      return {
        provider: "google",
        authUrl: GOOGLE_AUTH,
        tokenUrl: GOOGLE_TOKEN,
        clientId: reqEnv("GOOGLE_INTERNAL_CLIENT_ID"),
        clientSecret: reqEnv("GOOGLE_INTERNAL_CLIENT_SECRET"),
        redirectUri: redirectUri("google"),
        scopes,
      };
    case "google_external":
      return {
        provider: "google",
        authUrl: GOOGLE_AUTH,
        tokenUrl: GOOGLE_TOKEN,
        clientId: reqEnv("GOOGLE_EXTERNAL_CLIENT_ID"),
        clientSecret: reqEnv("GOOGLE_EXTERNAL_CLIENT_SECRET"),
        redirectUri: redirectUri("google"),
        scopes,
      };
    case "microsoft": {
      const tenant = reqEnv("MS_TENANT_ID");
      return {
        provider: "microsoft",
        authUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
        tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
        clientId: reqEnv("MS_CLIENT_ID"),
        clientSecret: reqEnv("MS_CLIENT_SECRET"),
        redirectUri: redirectUri("microsoft"),
        scopes,
      };
    }
  }
}
