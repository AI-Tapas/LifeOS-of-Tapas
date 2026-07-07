// The four fixed account slots and the rules for verifying which provider
// account may fill each one. A slot maps 1:1 to an accounts row via the
// accounts.slot column.

export type Provider = "google" | "microsoft";
export type OauthClientId = "google_internal" | "google_external" | "microsoft";

export interface Slot {
  key: string; // stored in accounts.slot
  label: string;
  provider: Provider;
  oauthClient: OauthClientId;
  scopes: string[]; // scopes requested at consent
  expectedEmail?: string; // exact address required (consumer slot)
  expectedDomain?: string; // address must be @domain (other-org slot)
  loginHint?: string;
  allowForwarded?: boolean; // icai only: may fall back to mail forwarding
  note?: string;
}

// Google scopes carry openid+email so the id_token returns the address the
// callback verifies the slot against. Microsoft carries offline_access (needed
// for a refresh token) plus User.Read.
const GOOGLE_RW = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];
const GOOGLE_ICAI = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
];
const MS_SCOPES = [
  "openid",
  "email",
  "profile",
  "offline_access",
  "User.Read",
  "Calendars.ReadWrite",
  "Mail.Read",
  "Mail.Send",
];

export const SLOTS: Slot[] = [
  {
    key: "taxstrategia",
    label: "Tax Strategia (Google Workspace)",
    provider: "google",
    oauthClient: "google_internal",
    scopes: GOOGLE_RW,
    note: "Internal client: only ever serves the Tax Strategia org, so any returned account is in-org.",
  },
  {
    key: "ca_tapasnr",
    label: "ca.tapasnr@gmail.com",
    provider: "google",
    oauthClient: "google_external",
    scopes: GOOGLE_RW,
    expectedEmail: "ca.tapasnr@gmail.com",
    loginHint: "ca.tapasnr@gmail.com",
    note: "Consumer Gmail on the deliberately unverified external client; click through the warning once.",
  },
  {
    key: "altechon",
    label: "Altechon (Microsoft 365)",
    provider: "microsoft",
    oauthClient: "microsoft",
    scopes: MS_SCOPES,
    note: "Single-tenant Entra app: only serves the Altechon tenant, so any returned account is in-tenant.",
  },
  {
    key: "icai",
    label: "icai.org (Workspace, restricted)",
    provider: "google",
    oauthClient: "google_external",
    scopes: GOOGLE_ICAI,
    expectedDomain: "icai.org",
    allowForwarded: true,
    note: "The org admin may block this unverified app; that is expected and falls back to mail forwarding.",
  },
];

// The Supabase sign-in identity. It must never be connected as a data account.
export const FORBIDDEN_EMAIL = "tapas.tnr@gmail.com";

export function slotByKey(key: string | null | undefined): Slot | undefined {
  if (!key) return undefined;
  return SLOTS.find((s) => s.key === key);
}

// Verify the provider-returned email is allowed to fill this slot.
export function verifySlotEmail(
  slot: Slot,
  email: string
): { ok: boolean; reason?: string } {
  const e = email.trim().toLowerCase();
  if (e === FORBIDDEN_EMAIL) {
    return {
      ok: false,
      reason: `${email} is your sign-in account and cannot be connected as a data account.`,
    };
  }
  if (slot.expectedEmail && e !== slot.expectedEmail.toLowerCase()) {
    return { ok: false, reason: `Expected ${slot.expectedEmail}, but got ${email}.` };
  }
  if (slot.expectedDomain && !e.endsWith("@" + slot.expectedDomain.toLowerCase())) {
    return {
      ok: false,
      reason: `Expected an @${slot.expectedDomain} account, but got ${email}.`,
    };
  }
  return { ok: true };
}
