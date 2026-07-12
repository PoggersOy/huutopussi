/**
 * Regenerates the PWA icons — icon-192.png, icon-512.png,
 * icon-maskable-512.png — into public/.
 *
 * Each icon is the brand logo (public/logo.png, the card-fan + megaphone)
 * composited on a dark felt-green ground with a soft highlight behind it. That
 * means the logo is a *raster* asset, and drawing it needs a real image
 * decoder — which this zero-dependency package doesn't have. So, exactly like
 * generate-og.mjs, this script emits a self-contained HTML file
 * (scripts/icons-card.html, git-ignored) that renders all three icons on a
 * <canvas> (supersampled ×2) with the logo embedded as a data URI. Open it in a
 * browser and click each **Download** button, saving over the matching file in
 * public/. The design (felt, glow, logo scale, shadow) lives here, so it stays
 * version-controlled, and because it derives from public/logo.png the icons can
 * never drift from the logo again.
 *
 *   pnpm --filter @hp/client icons          # writes scripts/icons-card.html
 *   open packages/client/scripts/icons-card.html   # click each Download
 *
 * Placement was calibrated to the previous committed icons: the logo is
 * centered and spans 80% of the canvas (63% for the maskable, whose extra
 * padding keeps the art inside the safe zone).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, '..', 'public');
const logoB64 = readFileSync(join(pub, 'logo.png')).toString('base64');

// [filename, size, motif width as a fraction of the canvas]
const ICONS = [
  ['icon-192.png', 192, 0.8],
  ['icon-512.png', 512, 0.8],
  ['icon-maskable-512.png', 512, 0.63],
];

const html = `<!doctype html>
<meta charset="utf-8">
<title>Huutopussi — PWA icons</title>
<body style="margin:0;background:#07271c;font-family:-apple-system,sans-serif;color:#f6f1e3;text-align:center">
<p style="padding:12px 0 2px">Click each button to save over <code>public/&lt;name&gt;</code>.</p>
<div id="out"></div>
<script>
const LOGO = 'data:image/png;base64,${logoB64}';
const ICONS = ${JSON.stringify(ICONS)};
const S = 2; // supersample

function draw(logo, N, mw) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = N * S;
  const g = cv.getContext('2d');
  const D = N * S;

  // Base felt — radial, subtly lighter at centre.
  const base = g.createRadialGradient(D * 0.5, D * 0.5, 0, D * 0.5, D * 0.5, D * 0.72);
  base.addColorStop(0, '#0d3c2c');
  base.addColorStop(1, '#07221a');
  g.fillStyle = base;
  g.fillRect(0, 0, D, D);

  // Soft green highlight behind the logo.
  const glow = g.createRadialGradient(D * 0.5, D * 0.37, 0, D * 0.5, D * 0.37, D * 0.44);
  glow.addColorStop(0, 'rgba(46,122,80,0.85)');
  glow.addColorStop(1, 'rgba(46,122,80,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, D, D);

  // Logo, centred, with a soft drop shadow.
  const lw = mw * D;
  const lh = lw * (logo.height / logo.width);
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.4)';
  g.shadowBlur = 0.03 * D;
  g.shadowOffsetY = 0.012 * D;
  g.drawImage(logo, (D - lw) / 2, (D - lh) / 2, lw, lh);
  g.restore();

  // Downscale ×2 → crisp N×N.
  const out = document.createElement('canvas');
  out.width = out.height = N;
  const o = out.getContext('2d');
  o.imageSmoothingEnabled = true;
  o.imageSmoothingQuality = 'high';
  o.drawImage(cv, 0, 0, N, N);
  return out;
}

const img = new Image();
img.onload = () => {
  const out = document.getElementById('out');
  for (const [name, N, mw] of ICONS) {
    const canvas = draw(img, N, mw);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:inline-block;margin:10px 14px;vertical-align:top';
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = name;
    a.textContent = 'Download ' + name;
    a.style.cssText = 'display:block;margin-top:6px;color:#e7c766;text-decoration:none;border:1px solid #c9aa66;border-radius:8px;padding:6px 10px';
    canvas.style.cssText = 'width:' + Math.min(N, 160) + 'px;image-rendering:auto;background:#000';
    wrap.appendChild(canvas);
    wrap.appendChild(a);
    out.appendChild(wrap);
    window.__icons = window.__icons || {};
    window.__icons[name] = a.href.split(',')[1];
  }
  window.__ready = true;
};
img.src = LOGO;
</script>`;

const out = join(here, 'icons-card.html');
writeFileSync(out, html);
console.log(
  'wrote scripts/icons-card.html — open it in a browser and click each Download,\n' +
    'saving over packages/client/public/{icon-192,icon-512,icon-maskable-512}.png.',
);
