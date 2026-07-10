/**
 * Generates the PWA icons (icon-192.png, icon-512.png, icon-maskable-512.png)
 * into public/ with zero dependencies: a tiny supersampled rasterizer draws a
 * two-card fan with a heart pip on a felt-green ground, and a minimal PNG
 * encoder (zlib + CRC32) writes the files. Deterministic; outputs are
 * committed, re-run with `pnpm --filter @hp/client icons` after art changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// ── Palette (matches src/styles/tokens.css) ──────────────────────────────────
const FELT_DARK = [7, 39, 28];
const FELT_LIGHT = [22, 88, 66];
const CARD_FACE = [253, 251, 244];
const CARD_FACE_BACK = [240, 234, 218];
const CARD_BORDER = [26, 26, 36];
const PIP_RED = [200, 16, 46];

// ── PNG encoding ─────────────────────────────────────────────────────────────

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** rgb: Uint8Array of size*size*3 (opaque). */
function encodePng(size, rgb) {
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgb.subarray(y * size * 3, (y + 1) * size * 3).forEach((v, i) => {
      raw[y * stride + 1 + i] = v;
    });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Shape tests ──────────────────────────────────────────────────────────────

function roundRectSdf(lx, ly, hw, hh, r) {
  const qx = Math.abs(lx) - (hw - r);
  const qy = Math.abs(ly) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Classic implicit heart, u right / v up, spans roughly |u|<1.15, -1<v<1.25. */
function inHeart(u, v) {
  if (u * u + v * v > 2.6) return false;
  const t = u * u + v * v - 1;
  return t * t * t - u * u * v * v * v <= 0;
}

/** Local coordinates of point p relative to a card rotated by `deg`. */
function toLocal(px, py, cx, cy, deg) {
  const th = (deg * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  return [dx * Math.cos(th) + dy * Math.sin(th), -dx * Math.sin(th) + dy * Math.cos(th)];
}

// ── Scene ────────────────────────────────────────────────────────────────────

/**
 * Color of the scene at point (px, py) on a canvas of width w.
 * `m` scales the motif toward the canvas center (maskable safe zone).
 */
function sceneColor(px, py, w, m) {
  const place = (fx, fy) => [w * (0.5 + (fx - 0.5) * m), w * (0.5 + (fy - 0.5) * m)];
  const hw = 0.2 * m * w; // card half-width
  const hh = 0.28 * m * w;
  const r = 0.045 * m * w;
  const border = 0.016 * m * w;

  // Front card (drawn on top): heart pip in the middle.
  {
    const [cx, cy] = place(0.585, 0.5);
    const [lx, ly] = toLocal(px, py, cx, cy, 9);
    const d = roundRectSdf(lx, ly, hw, hh, r);
    if (d <= 0) {
      if (d > -border) return CARD_BORDER;
      const s = 0.115 * m * w;
      if (inHeart(lx / s, -(ly - 0.015 * m * w) / s)) return PIP_RED;
      return CARD_FACE;
    }
  }

  // Back card: diamond pip on its visible edge.
  {
    const [cx, cy] = place(0.4, 0.54);
    const [lx, ly] = toLocal(px, py, cx, cy, -16);
    const d = roundRectSdf(lx, ly, hw, hh, r);
    if (d <= 0) {
      if (d > -border) return CARD_BORDER;
      const du = Math.abs(lx + 0.1 * m * w) + Math.abs(ly + 0.14 * m * w);
      if (du <= 0.06 * m * w) return PIP_RED;
      return CARD_FACE_BACK;
    }
  }

  // Felt background: radial falloff from upper center.
  const t = Math.min(1, Math.hypot(px - 0.5 * w, py - 0.42 * w) / (0.72 * w));
  return FELT_LIGHT.map((c, i) => c + (FELT_DARK[i] - c) * t);
}

// ── Render ───────────────────────────────────────────────────────────────────

function render(size, motifScale) {
  const SS = 3; // supersampling factor (poor man's anti-aliasing)
  const w = size * SS;
  const rgb = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sceneColor(x * SS + sx + 0.5, y * SS + sy + 0.5, w, motifScale);
          acc = [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]];
        }
      }
      const i = (y * size + x) * 3;
      rgb[i] = Math.round(acc[0] / (SS * SS));
      rgb[i + 1] = Math.round(acc[1] / (SS * SS));
      rgb[i + 2] = Math.round(acc[2] / (SS * SS));
    }
  }
  return encodePng(size, rgb);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [file, size, motifScale] of [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.68],
]) {
  const png = render(size, motifScale);
  writeFileSync(join(OUT_DIR, file), png);
  console.log(`wrote public/${file} (${png.length} bytes)`);
}
