// Generates assets/logo.png (256x256, transparent corners) and assets/background.png
// (1024x768). No dependencies: a tiny PNG encoder on node:zlib.
// Run: node scripts/make-assets.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const TEAL = [0x0b, 0x6e, 0x7f] as const;
const NAVY = [0x0e, 0x13, 0x1a] as const;

const chunk = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

const png = (width: number, height: number, channels: 3 | 4, pixel: (x: number, y: number) => number[]): Buffer => {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const px = pixel(x, y);
      for (let c = 0; c < channels; c++) raw[y * (stride + 1) + 1 + x * channels + c] = Math.round(px[c] ?? 0);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type: RGBA or RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const inRoundedRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const SIZE = 256;
const SAMPLES = 4;
const logo = png(SIZE, SIZE, 4, (px, py) => {
  let square = 0;
  let letter = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const x = px + (sx + 0.5) / SAMPLES;
      const y = py + (sy + 0.5) / SAMPLES;
      if (!inRoundedRect(x, y, 0, 0, SIZE, SIZE, 56)) continue;
      square++;
      if (inRoundedRect(x, y, 62, 68, 194, 108, 8) || inRoundedRect(x, y, 108, 68, 148, 196, 8)) letter++;
    }
  }
  const total = SAMPLES * SAMPLES;
  if (square === 0) return [TEAL[0], TEAL[1], TEAL[2], 0];
  const mix = letter / square;
  return [
    TEAL[0] + (255 - TEAL[0]) * mix,
    TEAL[1] + (255 - TEAL[1]) * mix,
    TEAL[2] + (255 - TEAL[2]) * mix,
    (square / total) * 255,
  ];
});

const background = png(1024, 768, 3, (_x, y) => {
  const t = y / 767;
  return [NAVY[0] + (TEAL[0] * 0.55 - NAVY[0]) * t, NAVY[1] + (TEAL[1] * 0.55 - NAVY[1]) * t, NAVY[2] + (TEAL[2] * 0.55 - NAVY[2]) * t];
});

mkdirSync(new URL("../assets/", import.meta.url), { recursive: true });
writeFileSync(new URL("../assets/logo.png", import.meta.url), logo);
writeFileSync(new URL("../assets/background.png", import.meta.url), background);
console.log(`logo.png ${logo.length} bytes, background.png ${background.length} bytes`);
