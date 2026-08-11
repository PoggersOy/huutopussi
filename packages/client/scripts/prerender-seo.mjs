import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const packageDir = resolve(scriptDir, '..');
const distDir = resolve(process.argv[2] ?? join(packageDir, 'dist'));
const pages = JSON.parse(readFileSync(join(packageDir, 'src', 'seo-pages.json'), 'utf8'));
const fi = JSON.parse(readFileSync(join(packageDir, 'src', 'i18n', 'fi.json'), 'utf8'));

const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const rulesSteps = ['objective', 'cards', 'bidding', 'exchange', 'play', 'marriage', 'scoring'];

function rulesBody() {
  const sections = rulesSteps
    .map(
      (key) => `
        <section>
          <h2>${escapeHtml(fi.rulesPage.how[key].title)}</h2>
          <p>${escapeHtml(fi.rulesPage.how[key].body)}</p>
        </section>`,
    )
    .join('');
  return `
    <article class="screen seo-prerender">
      <header class="screen__top">
        <h1>${escapeHtml(fi.rulesPage.title)}</h1>
        <p>${escapeHtml(fi.rulesPage.intro)}</p>
      </header>
      <main class="screen__main">
        ${sections}
        <section>
          <h2>${escapeHtml(fi.rulesPage.rankOrder)}</h2>
          <p>Ässä, 10, kuningas, rouva, jätkä, 9, 8, 7, 6. Kymppi voittaa kuninkaan.</p>
          <h2>${escapeHtml(fi.rulesPage.suitValues)}</h2>
          <p>Hertta 100, ruutu 80, risti 60 ja pata 40 pistettä.</p>
        </section>
        <nav aria-label="Jatka Huutopussin pelaamiseen tai opetteluun">
          <a href="/opettele">Opettele Huutopussia ohjatusti</a>
          <a href="/">Pelaa Huutopussia verkossa</a>
        </nav>
      </main>
    </article>`;
}

function learnBody() {
  const scenarioKeys = ['bidding', 'marriage', 'trick', 'endgame'];
  const scenarios = scenarioKeys
    .map(
      (key) => `
        <section>
          <h2>${escapeHtml(fi.learn.scenarioTitle[key])}</h2>
          <p>${escapeHtml(fi.learn.scenarioDesc[key])}</p>
        </section>`,
    )
    .join('');
  return `
    <article class="screen seo-prerender">
      <header class="screen__top">
        <h1>${escapeHtml(fi.learn.menuTitle)}</h1>
        <p>${escapeHtml(fi.learn.menuIntro)}</p>
      </header>
      <main class="screen__main">
        <section>
          <h2>${escapeHtml(fi.learn.tutorialTitle)}</h2>
          <p>${escapeHtml(fi.learn.tutorialDesc)}</p>
        </section>
        <h2>${escapeHtml(fi.learn.puzzlesTitle)}</h2>
        ${scenarios}
        <nav aria-label="Huutopussin ohjeet ja pelaaminen">
          <a href="/saannot">Lue Huutopussin säännöt</a>
          <a href="/">Pelaa Huutopussia verkossa</a>
        </nav>
      </main>
    </article>`;
}

function replaceMeta(html, page) {
  const description = escapeHtml(page.description);
  const canonical = escapeHtml(page.canonical);
  const ogTitle = escapeHtml(page.ogTitle);
  const ogDescription = escapeHtml(page.ogDescription);
  return html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(page.title)}</title>`)
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
      `<meta name="description" content="${description}" />`,
    )
    .replace(
      /<link rel="canonical" href="[^"]*"\s*\/>/,
      `<link rel="canonical" href="${canonical}" />`,
    )
    .replaceAll(
      /(<link rel="alternate" hreflang="[^"]+" href=")[^"]*("\s*\/>)/g,
      `$1${canonical}$2`,
    )
    .replace(
      /<meta property="og:title" content="[^"]*"\s*\/>/,
      `<meta property="og:title" content="${ogTitle}" />`,
    )
    .replace(
      /<meta\s+property="og:description"\s+content="[^"]*"\s*\/>/,
      `<meta property="og:description" content="${ogDescription}" />`,
    )
    .replace(
      /<meta property="og:url" content="[^"]*"\s*\/>/,
      `<meta property="og:url" content="${canonical}" />`,
    )
    .replace(
      /<meta name="twitter:title" content="[^"]*"\s*\/>/,
      `<meta name="twitter:title" content="${ogTitle}" />`,
    )
    .replace(
      /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/>/,
      `<meta name="twitter:description" content="${ogDescription}" />`,
    );
}

function renderPage(template, path, body) {
  const page = pages[path];
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': `${page.canonical}#webpage`,
    url: page.canonical,
    name: page.title,
    description: page.description,
    inLanguage: 'fi',
    isPartOf: { '@id': 'https://huutopussi.online/#website' },
    about: { '@id': 'https://huutopussi.online/#app' },
  };
  return replaceMeta(template, page)
    .replace(
      '</head>',
      `  <script type="application/ld+json">${JSON.stringify(schema)}</script>\n  </head>`,
    )
    .replace('<div id="root"></div>', `<div id="root">${body}</div>`);
}

const template = readFileSync(join(distDir, 'index.html'), 'utf8');
for (const [slug, body] of [
  ['saannot', rulesBody()],
  ['opettele', learnBody()],
]) {
  const targetDir = join(distDir, slug);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'index.html'), renderPage(template, `/${slug}`, body));
}
