// Generates placeholder PWA icons as PNGs with no image dependencies:
// a slate background with a centred indigo rounded square.
// Run: node scripts/gen-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size) {
  const bg = [15, 23, 42]; // slate-900
  const fg = [99, 102, 241]; // indigo-500
  const lo = Math.round(size * 0.28);
  const hi = Math.round(size * 0.72);
  const r = Math.round(size * 0.08);

  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let inside = x >= lo && x < hi && y >= lo && y < hi;
      if (inside) {
        // knock the corners off for a rounded look
        const dx = Math.max(lo + r - x, x - (hi - 1 - r), 0);
        const dy = Math.max(lo + r - y, y - (hi - 1 - r), 0);
        if (dx * dx + dy * dy > r * r) inside = false;
      }
      const [cr, cg, cb] = inside ? fg : bg;
      const p = row + 1 + x * 3;
      raw[p] = cr;
      raw[p + 1] = cg;
      raw[p + 2] = cb;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public/icons", { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(`public/icons/icon-${size}.png`, png(size));
  console.log(`public/icons/icon-${size}.png`);
}
