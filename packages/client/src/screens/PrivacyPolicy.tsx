/**
 * PrivacyPolicy ("Tietosuojaseloste"): the GDPR art. 13 disclosure, reachable
 * from the front page and the profile. Kept deliberately plain and specific to
 * what this game actually does — the same facts the code enforces: we store a
 * Google account id + reduced name ("First L.") + avatar, a guest nickname, and
 * Elo/match history; no email, no cookies of our own, and only privacy-first
 * cookieless visitor analytics (Cloudflare Web Analytics, aggregate counts, no
 * identification). All copy is i18n (fi fallback); the controller/contact
 * details are interpolated so they live in one place.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ConnectionPill } from '../components/ConnectionPill';

/** Controller identity + contact, interpolated into the policy copy. */
const ORG = 'Poggers Oy';
const SITE = 'huutopussi.online';
const CONTACT_EMAIL = 'contact@poggers.fi';
/** GDPR consent age in Finland, also our recommended minimum age. */
const MIN_AGE = 13;

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="panel stack">
      <h2>{heading}</h2>
      {children}
    </section>
  );
}

export function PrivacyPolicy() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const p = { org: ORG, site: SITE, email: CONTACT_EMAIL, age: MIN_AGE };

  return (
    <div className="screen">
      <header className="screen__top">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1>{t('privacy.title')}</h1>
          <ConnectionPill />
        </div>
        <p className="dim">{t('privacy.intro', p)}</p>
        <p className="dim">{t('privacy.updated')}</p>
      </header>

      <main className="screen__main">
        <Section heading={t('privacy.controllerH')}>
          <p className="dim">{t('privacy.controllerB', p)}</p>
        </Section>

        <Section heading={t('privacy.dataH')}>
          <p className="dim">{t('privacy.dataIntro')}</p>
          <ul className="list-bullets dim">
            <li>{t('privacy.dataGoogle')}</li>
            <li>{t('privacy.dataNickname')}</li>
            <li>{t('privacy.dataElo')}</li>
            <li>{t('privacy.dataToken')}</li>
          </ul>
          <p className="dim">{t('privacy.dataNone')}</p>
        </Section>

        <Section heading={t('privacy.purposeH')}>
          <p className="dim">{t('privacy.purposeB')}</p>
        </Section>

        <Section heading={t('privacy.thirdH')}>
          <p className="dim">{t('privacy.thirdIntro')}</p>
          <ul className="list-bullets dim">
            <li>{t('privacy.thirdGoogle')}</li>
            <li>{t('privacy.thirdFly')}</li>
            <li>{t('privacy.thirdCloudflare')}</li>
          </ul>
        </Section>

        <Section heading={t('privacy.cookiesH')}>
          <p className="dim">{t('privacy.cookiesB')}</p>
        </Section>

        <Section heading={t('privacy.analyticsH')}>
          <p className="dim">{t('privacy.analyticsB', p)}</p>
        </Section>

        <Section heading={t('privacy.retentionH')}>
          <p className="dim">{t('privacy.retentionB')}</p>
        </Section>

        <Section heading={t('privacy.rightsH')}>
          <p className="dim">{t('privacy.rightsIntro')}</p>
          <ul className="list-bullets dim">
            <li>{t('privacy.rightsAccess')}</li>
            <li>{t('privacy.rightsRectify')}</li>
            <li>{t('privacy.rightsErase')}</li>
            <li>{t('privacy.rightsPortability')}</li>
            <li>{t('privacy.rightsComplaint')}</li>
          </ul>
        </Section>

        <Section heading={t('privacy.deletionH')}>
          <p className="dim">{t('privacy.deletionB')}</p>
        </Section>

        <Section heading={t('privacy.ageH')}>
          <p className="dim">{t('privacy.ageB', p)}</p>
        </Section>

        <Section heading={t('privacy.contactH')}>
          <p className="dim">{t('privacy.contactB', p)}</p>
          <a className="link" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
        </Section>
      </main>

      <footer className="screen__bottom">
        <button type="button" style={{ width: '100%' }} onClick={() => navigate('/')}>
          {t('common.back')}
        </button>
      </footer>
    </div>
  );
}
