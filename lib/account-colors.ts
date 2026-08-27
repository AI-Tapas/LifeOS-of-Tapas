// Per-account colours for the unified calendar. The calendar is coloured by
// account (not by individual calendar) for legibility on a phone, so each of the
// four slots gets one fixed, distinct hue. Kept as a CSS var() reference plus a
// soft background so event chips can use inline styles (Tailwind cannot JIT
// class names built from data at runtime) while still picking up the right
// shade per theme - the light/dark values themselves live in globals.css
// alongside the rest of the design tokens. calendars.color from M2 is still
// available per calendar, but a stable per-account palette reads far better on
// a 6-inch screen.

export interface AccountColor {
  hex: string; // strong hue: dots, left borders
  soft: string; // translucent fill for chips
}

const PALETTE: Record<string, AccountColor> = {
  taxstrategia: { hex: "var(--acct-taxstrategia)", soft: "var(--acct-taxstrategia-soft)" }, // clay
  ca_tapasnr: { hex: "var(--acct-personal)", soft: "var(--acct-personal-soft)" }, // dusty
  altechon: { hex: "var(--acct-altechon)", soft: "var(--acct-altechon-soft)" }, // violet
  icai: { hex: "var(--acct-icai)", soft: "var(--acct-icai-soft)" }, // sage
};

const FALLBACK: AccountColor = { hex: "var(--acct-fallback)", soft: "var(--acct-fallback-soft)" };

export function accountColor(slot: string | null | undefined): AccountColor {
  return (slot && PALETTE[slot]) || FALLBACK;
}
