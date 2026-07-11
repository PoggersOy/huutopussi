/**
 * Generates the social-share image public/og-image.png (1200×630, the Open
 * Graph / Twitter-card size referenced from index.html) with zero
 * dependencies — same technique as generate-icons.mjs: a supersampled SDF
 * rasterizer draws the two-card fan on felt inside a soft gold frame, and a
 * minimal zlib+CRC32 PNG encoder writes the file. Deterministic; the output is
 * committed. Re-run with `pnpm --filter @hp/client og` after art changes.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'og-image.png');
const W = 1200;
const H = 630;

// ── Palette (matches src/styles/tokens.css and generate-icons.mjs) ────────────
const FELT_DARK = [7, 39, 28];
const FELT_LIGHT = [22, 88, 66];
const CARD_FACE = [253, 251, 244];
const CARD_FACE_BACK = [240, 234, 218];
const CARD_BORDER = [26, 26, 36];
const PIP_RED = [200, 16, 46];
const FRAME_GOLD = [214, 188, 120];

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

/** rgb: Uint8Array of w*h*3 (opaque truecolor). */
function encodePng(w, h, rgb) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgb.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => {
      raw[y * stride + 1 + i] = v;
    });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Shape tests (shared with the icon generator) ─────────────────────────────

function roundRectSdf(lx, ly, hw, hh, r) {
  const qx = Math.abs(lx) - (hw - r);
  const qy = Math.abs(ly) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Classic implicit heart, u right / v up. */
function inHeart(u, v) {
  if (u * u + v * v > 2.6) return false;
  const t = u * u + v * v - 1;
  return t * t * t - u * u * v * v * v <= 0;
}

/** Local coordinates of point p relative to a card centered at (cx,cy), rotated `deg`. */
function toLocal(px, py, cx, cy, deg) {
  const th = (deg * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  return [dx * Math.cos(th) + dy * Math.sin(th), -dx * Math.sin(th) + dy * Math.cos(th)];
}

function lerp(a, b, t) {
  return a.map((c, i) => c + (b[i] - c) * t);
}

// ── Scene ────────────────────────────────────────────────────────────────────

/** The card fan, drawn on top of the felt. Returns a color or null (no card). */
function cardLayer(px, py, mcx, mcy, s) {
  const place = (fx, fy) => [mcx + (fx - 0.5) * s, mcy + (fy - 0.5) * s];
  const hw = 0.2 * s;
  const hh = 0.28 * s;
  const r = 0.045 * s;
  const border = 0.016 * s;

  // Front card: heart pip in the middle.
  {
    const [cx, cy] = place(0.585, 0.5);
    const [lx, ly] = toLocal(px, py, cx, cy, 9);
    const d = roundRectSdf(lx, ly, hw, hh, r);
    if (d <= 0) {
      if (d > -border) return CARD_BORDER;
      const ps = 0.115 * s;
      if (inHeart(lx / ps, -(ly - 0.015 * s) / ps)) return PIP_RED;
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
      const du = Math.abs(lx + 0.1 * s) + Math.abs(ly + 0.14 * s);
      if (du <= 0.06 * s) return PIP_RED;
      return CARD_FACE_BACK;
    }
  }
  return null;
}

/** Felt background with a radial highlight and a corner vignette. */
function feltColor(px, py) {
  const t = Math.min(1, Math.hypot(px - 0.5 * W, py - 0.4 * H) / (0.78 * W));
  const base = lerp(FELT_LIGHT, FELT_DARK, t);
  const vx = (px - 0.5 * W) / (0.5 * W);
  const vy = (py - 0.5 * H) / (0.5 * H);
  const vig = Math.min(0.42, (vx * vx + vy * vy) * 0.3);
  return base.map((c) => c * (1 - vig));
}

/** A thin rounded gold frame inset from the edges (a "poster" border). */
function frameAlpha(px, py) {
  const d = roundRectSdf(px - W / 2, py - H / 2, W / 2 - 34, H / 2 - 34, 26);
  // Soft 2px feather on both sides of a 3px-thick stroke.
  const a = 1 - Math.min(1, Math.abs(d + 1.5) / 3.5);
  return Math.max(0, a);
}

function sceneColor(px, py) {
  const card = cardLayer(px, py, W / 2, H / 2 - 8, 470);
  if (card) return card; // cards are opaque and sit above the frame
  const felt = feltColor(px, py);
  const fa = frameAlpha(px, py);
  return fa > 0 ? lerp(felt, FRAME_GOLD, 0.55 * fa) : felt;
}

// ── Render ───────────────────────────────────────────────────────────────────

const SS = 2; // supersampling factor (anti-aliasing)
const rgb = new Uint8Array(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sceneColor(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        acc = [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]];
      }
    }
    const i = (y * W + x) * 3;
    rgb[i] = Math.round(acc[0] / (SS * SS));
    rgb[i + 1] = Math.round(acc[1] / (SS * SS));
    rgb[i + 2] = Math.round(acc[2] / (SS * SS));
  }
}

const png = encodePng(W, H, rgb);
writeFileSync(OUT, png);
console.log(`wrote public/og-image.png (${W}×${H}, ${png.length} bytes)`);
