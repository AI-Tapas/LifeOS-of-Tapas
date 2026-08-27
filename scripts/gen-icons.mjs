// Generates the PWA icons from an inline SVG: Slate and Clay identity, a
// serif "L." on deep slate. The letterform is a hand-drawn path (no <text>),
// so rasterisation is identical on every machine regardless of installed
// fonts. Run: node scripts/gen-icons.mjs  (also: npm run icons)
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const SLATE = "#14283f"; // dark surface token
const SLATE_DEEP = "#0f1e30"; // dark background token
const CREAM = "#f4efe9"; // warm off-white, matches the Desk feel
const CLAY = "#a66e5e"; // --brand

// One 1000x1000 art board. The mark sits inside the centre ~55% so the same
// art survives a maskable circle crop (safe zone is the centre 80%).
// The "L" is a classic bracketed-serif capital: vertical stem, foot arm,
// head and foot serifs, drawn as one path on a 1000-unit grid.
function svg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <defs>
    <radialGradient id="bg" cx="50%" cy="30%" r="90%">
      <stop offset="0%" stop-color="${SLATE}"/>
      <stop offset="100%" stop-color="${SLATE_DEEP}"/>
    </radialGradient>
  </defs>
  <rect width="1000" height="1000" fill="url(#bg)"/>
  <!-- hairline ring, a quiet nod to the app's card borders; r stays inside
       the maskable safe zone (centre 80%) so no launcher shape shaves it -->
  <circle cx="500" cy="500" r="385" fill="none" stroke="#2c4f77" stroke-width="6" opacity="0.55"/>
  <!-- serif L: stem with head serif, foot arm rising to a flared terminal -->
  <path fill="${CREAM}" d="
    M 338 300
    L 522 300
    L 522 322
    C 492 326, 480 332, 480 366
    L 480 640
    C 480 666, 488 674, 514 674
    L 550 674
    C 596 674, 616 658, 630 606
    L 656 612
    L 634 700
    L 338 700
    L 338 678
    C 368 674, 380 668, 380 634
    L 380 366
    C 380 332, 368 326, 338 322
    Z"/>
  <!-- the clay full stop, sitting on the same baseline -->
  <circle cx="692" cy="666" r="34" fill="${CLAY}"/>
</svg>`;
}

mkdirSync("public/icons", { recursive: true });
const art = Buffer.from(svg());
for (const size of [180, 192, 512]) {
  await sharp(art, { density: 300 })
    .resize(size, size)
    .png()
    .toFile(`public/icons/icon-${size}.png`);
  console.log(`public/icons/icon-${size}.png`);
}
