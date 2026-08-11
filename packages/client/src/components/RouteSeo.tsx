import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import seoPages from '../seo-pages.json';

type SeoPath = keyof typeof seoPages;
type SeoPage = (typeof seoPages)[SeoPath];

const INDEXABLE_PATHS = new Set<SeoPath>(['/', '/saannot', '/opettele']);

function pageFor(pathname: string): { indexable: boolean; page: SeoPage } {
  if (INDEXABLE_PATHS.has(pathname as SeoPath)) {
    return { indexable: true, page: seoPages[pathname as SeoPath] };
  }
  if (pathname === '/rules') return { indexable: false, page: seoPages['/saannot'] };
  if (pathname === '/learn' || pathname.startsWith('/learn/')) {
    return { indexable: false, page: seoPages['/opettele'] };
  }
  if (pathname.startsWith('/opettele/')) {
    return { indexable: false, page: seoPages['/opettele'] };
  }
  return { indexable: false, page: seoPages['/'] };
}

function setMeta(attribute: 'name' | 'property', key: string, content: string): void {
  let meta = document.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (meta === null) {
    meta = document.createElement('meta');
    meta.setAttribute(attribute, key);
    document.head.append(meta);
  }
  meta.setAttribute('content', content);
}

function setCanonical(href: string): void {
  let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (canonical === null) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.append(canonical);
  }
  canonical.href = href;
}

/** Keep client-side navigation metadata aligned with the pre-rendered route HTML. */
export function RouteSeo() {
  const { pathname } = useLocation();

  useEffect(() => {
    const { indexable, page } = pageFor(pathname);
    document.title = page.title;
    setMeta('name', 'description', page.description);
    setMeta(
      'name',
      'robots',
      indexable
        ? 'index, follow, max-image-preview:large, max-snippet:-1'
        : 'noindex, follow, max-image-preview:large, max-snippet:-1',
    );
    setMeta('property', 'og:title', page.ogTitle);
    setMeta('property', 'og:description', page.ogDescription);
    setMeta('property', 'og:url', page.canonical);
    setMeta('name', 'twitter:title', page.ogTitle);
    setMeta('name', 'twitter:description', page.ogDescription);
    setCanonical(page.canonical);
    for (const alternate of document.querySelectorAll<HTMLLinkElement>(
      'link[rel="alternate"][hreflang]',
    )) {
      alternate.setAttribute('href', page.canonical);
    }
  }, [pathname]);

  return null;
}
