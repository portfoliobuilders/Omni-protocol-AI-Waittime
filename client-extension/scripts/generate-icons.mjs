/**
 * Generates OmniPiggy extension icons (16/32/48/128 px).
 * Run: node scripts/generate-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "../public/icons");

const BG = [0x14, 0x14, 0x16, 0xff];
const FG = [0x22, 0xc5, 0x5e, 0xff];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function dist(x, y, cx, cy) {
  return Math.hypot(x - cx, y - cy);
}

function roundedRectMask(x, y, size, radius) {
  const r = Math.min(radius, size / 2);
  const left = r;
  const right = size - 1 - r;
  const top = r;
  const bottom = size - 1 - r;

  if (x < left && y < top) return dist(x, y, left, top) <= r;
  if (x > right && y < top) return dist(x, y, right, top) <= r;
  if (x < left && y > bottom) return dist(x, y, left, bottom) <= r;
  if (x > right && y > bottom) return dist(x, y, right, bottom) <= r;
  return true;
}

function drawIcon(size) {
  const data = new Uint8Array(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = Math.max(2, Math.round(size * 0.22));
  const outerR = size * 0.28;
  const innerR = size * 0.14;
  const stroke = Math.max(1, Math.round(size * 0.09));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!roundedRectMask(x, y, size, radius)) continue;

      data[i] = BG[0];
      data[i + 1] = BG[1];
      data[i + 2] = BG[2];
      data[i + 3] = BG[3];

      const d = dist(x, y, cx, cy);
      const ring =
        d <= outerR + stroke / 2 &&
        d >= innerR - stroke / 2 &&
        (d >= innerR + stroke / 2 || d <= outerR - stroke / 2);

      if (ring || (size <= 16 && d <= outerR && d >= innerR - 0.5)) {
        data[i] = FG[0];
        data[i + 1] = FG[1];
        data[i + 2] = FG[2];
        data[i + 3] = FG[3];
      }

      // Small slot at top — piggy-bank coin hint
      if (size >= 32) {
        const slotW = size * 0.12;
        const slotH = size * 0.06;
        const slotY = cy - outerR - slotH * 0.35;
        if (
          Math.abs(x - cx) <= slotW / 2 &&
          y >= slotY - slotH / 2 &&
          y <= slotY + slotH / 2
        ) {
          data[i] = FG[0];
          data[i + 1] = FG[1];
          data[i + 2] = FG[2];
          data[i + 3] = FG[3];
        }
      }
    }
  }

  return data;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = rowStart + 1 + x * 4;
      raw[dst] = rgba[src];
      raw[dst + 1] = rgba[src + 1];
      raw[dst + 2] = rgba[src + 2];
      raw[dst + 3] = rgba[src + 3];
    }
  }

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const rgba = drawIcon(size);
  const png = encodePng(size, rgba);
  const outPath = resolve(OUT_DIR, `icon-${size}.png`);
  writeFileSync(outPath, png);
  console.log(`Wrote ${outPath}`);
}
