// The extension's icon, drawn at build time (no image files in the repository): the keychain's key
// of the web page (`IconKey` of icons.tsx, the same strokes) in white on RedGiant's red, as PNG.
import { deflateSync } from "node:zlib";

const RED = [0xd2, 0x3a, 0x2c];

// The key in the 24-unit box of the page's icons.
const RING = { cx: 7.5, cy: 15.5, r: 4.5 };
const SEGMENTS = [
  [10.7, 12.3, 21, 2],
  [17, 6, 20, 9],
  [14.5, 8.5, 16.5, 10.5],
];

function segmentDistance(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Inside a rounded square of side 1 with corner radius r? */
function inRounded(x, y, r) {
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const qy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return Math.hypot(qx, qy) <= r;
}

/** RGBA pixels of the icon at `size`, 4×4 samples per pixel. */
export function drawIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const n = 4;
  // Thicker strokes where pixels are few.
  const stroke = size <= 16 ? 3 : size <= 32 ? 2.6 : 2.2;
  const inner = 0.66;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let key = 0;
      for (let sy = 0; sy < n; sy++)
        for (let sx = 0; sx < n; sx++) {
          const u = (x + (sx + 0.5) / n) / size;
          const v = (y + (sy + 0.5) / n) / size;
          if (!inRounded(u, v, 0.24)) continue;
          bg++;
          // From the icon's square to the key's 24-unit box, centred.
          const kx = ((u - (1 - inner) / 2) / inner) * 24;
          const ky = ((v - (1 - inner) / 2) / inner) * 24;
          const ring = Math.abs(Math.hypot(kx - RING.cx, ky - RING.cy) - RING.r);
          const d = Math.min(ring, ...SEGMENTS.map((s) => segmentDistance(kx, ky, s)));
          if (d <= stroke / 2) key++;
        }
      const i = (y * size + x) * 4;
      const a = bg / (n * n);
      const w = bg ? key / bg : 0;
      px[i] = Math.round(RED[0] + (255 - RED[0]) * w);
      px[i + 1] = Math.round(RED[1] + (255 - RED[1]) * w);
      px[i + 2] = Math.round(RED[2] + (255 - RED[2]) * w);
      px[i + 3] = Math.round(a * 255);
    }
  return px;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** The icon as a PNG file. */
export function iconPng(size) {
  const px = drawIcon(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.subarray(y * size * 4, (y + 1) * size * 4)).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
