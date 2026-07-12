/**
 * Regenerates the social-share card public/og-image.png (1200×630, the Open
 * Graph / Twitter-card size referenced from index.html).
 *
 * The card carries the slogan as *text*, and rendering text needs a font
 * engine. This package has zero image/font dependencies, so instead of
 * rasterizing here we emit a self-contained HTML file (scripts/og-card.html,
 * git-ignored) that draws the whole card on a <canvas> — supersampled ×2 for
 * crisp type — using the felt/gold brand from src/styles/tokens.css, with the
 * logo embedded as a data URI. Open it in a browser and click **Download** to
 * save the PNG over public/og-image.png. The card's design (layout, colours,
 * slogan) is fully described *here*, so it stays version-controlled.
 *
 *   pnpm --filter @hp/client og      # writes scripts/og-card.html
 *   open packages/client/scripts/og-card.html   # then click Download
 *
 * The slogan below must mirror `home.tagline` in src/i18n/fi.json. It is split
 * on the en-dash into a gold headline + a cream subline.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, '..', 'public');
const logoB64 = readFileSync(join(pub, 'logo.png')).toString('base64');

const SLOGAN = 'Ilmainen Huutopussi verkossa – pelaa heti yksin tai kavereiden kanssa.';
const [headRaw, subRaw] = SLOGAN.split(' – ');
const HEAD = headRaw.trim();
const SUB = subRaw.replace(/\.$/, '').trim();
const URLTXT = 'huutopussi.online';

const html = `<!doctype html>
<meta charset="utf-8">
<title>Huutopussi — og-image card</title>
<body style="margin:0;background:#07271c;font-family:-apple-system,sans-serif;color:#f6f1e3;text-align:center">
<p style="padding:12px 0 4px">1200×630 preview — click to save over <code>public/og-image.png</code></p>
<p><a id="dl" download="og-image.png" style="display:inline-block;padding:8px 18px;border:1px solid #c9aa66;border-radius:8px;color:#e7c766;text-decoration:none">Download og-image.png</a></p>
<canvas id="c" width="2400" height="1260" style="width:600px;border:1px solid #10493a"></canvas>
<script>
const HEAD = ${JSON.stringify(HEAD)};
const SUB = ${JSON.stringify(SUB)};
const URLTXT = ${JSON.stringify(URLTXT)};
const LOGO = 'data:image/png;base64,${logoB64}';

const S = 2, W = 1200 * S, H = 630 * S;
const cv = document.getElementById('c');
const g = cv.getContext('2d');

function rr(x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Shrink a font until the text fits within maxW canvas px.
function fit(text, family, weight, startPx, maxW) {
  let px = startPx;
  for (;;) {
    g.font = weight + ' ' + px + 'px ' + family;
    if (g.measureText(text).width <= maxW || px <= 12) return px;
    px -= 1;
  }
}

function draw(logo) {
  // Felt: radial highlight (upper-centre) fading into a deep vignette.
  const grad = g.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.42, W * 0.72);
  grad.addColorStop(0, '#186a51');
  grad.addColorStop(0.55, '#0b3d2e');
  grad.addColorStop(1, '#062018');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const vig = g.createRadialGradient(W * 0.5, H * 0.5, H * 0.35, W * 0.5, H * 0.5, W * 0.62);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.34)');
  g.fillStyle = vig;
  g.fillRect(0, 0, W, H);

  // Gold poster frame.
  g.strokeStyle = 'rgba(201,170,102,0.75)';
  g.lineWidth = 3 * S;
  rr(34 * S, 34 * S, W - 68 * S, H - 68 * S, 26 * S);
  g.stroke();

  // Logo, top-centre, soft drop shadow.
  const lh = 250 * S;
  const lw = lh * (logo.width / logo.height);
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = 26 * S;
  g.shadowOffsetY = 9 * S;
  g.drawImage(logo, (W - lw) / 2, 56 * S, lw, lh);
  g.restore();

  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const maxW = W - 130 * S;

  // Headline — gold serif.
  const hPx = fit(HEAD, 'Georgia, "Times New Roman", serif', '700', 58 * S, maxW);
  g.font = '700 ' + hPx + 'px Georgia, "Times New Roman", serif';
  g.fillStyle = '#e7c766';
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 6 * S;
  g.shadowOffsetY = 2 * S;
  g.fillText(HEAD, W / 2, 392 * S);
  g.shadowColor = 'transparent';

  // Thin gold rule under the headline.
  const rW = Math.min(maxW, g.measureText(HEAD).width) * 0.5;
  g.strokeStyle = 'rgba(201,170,102,0.55)';
  g.lineWidth = 2 * S;
  g.beginPath();
  g.moveTo(W / 2 - rW / 2, 418 * S);
  g.lineTo(W / 2 + rW / 2, 418 * S);
  g.stroke();

  // Subline — cream sans.
  const sPx = fit(SUB, '-apple-system, "Segoe UI", Roboto, sans-serif', '400', 37 * S, maxW);
  g.font = '400 ' + sPx + 'px -apple-system, "Segoe UI", Roboto, sans-serif';
  g.fillStyle = '#f6f1e3';
  g.fillText(SUB, W / 2, 470 * S);

  // URL — gold-soft, letter-spaced (hair spaces).
  g.font = '600 ' + 25 * S + 'px -apple-system, "Segoe UI", Roboto, sans-serif';
  g.fillStyle = '#c9aa66';
  g.fillText(URLTXT.toUpperCase().split('').join('\\u200a'), W / 2, 560 * S);

  // Downscale ×2 → crisp 1200×630 export, wire up the Download link.
  const out = document.createElement('canvas');
  out.width = 1200;
  out.height = 630;
  const o = out.getContext('2d');
  o.imageSmoothingEnabled = true;
  o.imageSmoothingQuality = 'high';
  o.drawImage(cv, 0, 0, 1200, 630);
  document.getElementById('dl').href = out.toDataURL('image/png');
}

const img = new Image();
img.onload = () => draw(img);
img.src = LOGO;
</script>`;

const out = join(here, 'og-card.html');
writeFileSync(out, html);
console.log(
  'wrote scripts/og-card.html — open it in a browser and click Download, then\n' +
    'save the PNG over packages/client/public/og-image.png (1200×630).',
);
