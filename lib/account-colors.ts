// Per-account colours for the unified calendar. The calendar is coloured by
// account (not by individual calendar) for legibility on a phone, so each of the
// four slots gets one fixed, distinct hue. Kept as hex plus a soft background so
// event chips can use inline styles (Tailwind cannot JIT class names built from
// data at runtime). calendars.color from M2 is still available per calendar, but
// a stable per-account palette reads far better on a 6-inch screen.

export interface AccountColor {
  hex: string; // strong hue: dots, left borders, dark text
  soft: string; // translucent fill for chips
}

const PALETTE: Record<string, AccountColor> = {
  taxstrategia: { hex: "#4f46e5", soft: "rgba(79,70,229,0.14)" }, // indigo
  ca_tapasnr: { hex: "#059669", soft: "rgba(5,150,105,0.14)" }, // emerald
  altechon: { hex: "#0284c7", soft: "rgba(2,132,199,0.14)" }, // sky
  icai: { hex: "#d97706", soft: "rgba(217,119,6,0.14)" }, // amber
};

const FALLBACK: AccountColor = { hex: "#475569", soft: "rgba(71,85,105,0.14)" };

export function accountColor(slot: string | null | undefined): AccountColor {
  return (slot && PALETTE[slot]) || FALLBACK;
}
