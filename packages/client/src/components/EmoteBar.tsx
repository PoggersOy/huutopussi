/**
 * The in-table reaction picker — a floating button that opens a grouped palette
 * of preset emotes (no free text). Seated players only; spectators can't react.
 * Tapping a reaction fires it to the server (which echoes it to everyone, us
 * included) and starts a short local cooldown that mirrors the server's gate.
 */
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EMOTE_CATEGORIES, EMOTES } from '../emotes';
import { primeAudio } from '../feedback';
import { sendEmote } from '../socket';
import { useStore } from '../store';

/** Local cooldown between reactions (matches the server's EMOTE_COOLDOWN_MS). */
const COOLDOWN_MS = 1_500;

export function EmoteBar(): ReactElement | null {
  const { t } = useTranslation();
  const seat = useStore((s) => s.server.seat);
  const connected = useStore((s) => s.server.connected);
  const [open, setOpen] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);

  // Spectators (no seat) can watch but not react.
  if (seat === null) return null;

  function pick(id: (typeof EMOTES)[number]['id']): void {
    primeAudio();
    if (Date.now() < cooldownUntil) return;
    if (sendEmote(id)) {
      setCooldownUntil(Date.now() + COOLDOWN_MS);
      setOpen(false);
    }
  }

  return (
    <div className={`emotebar${open ? ' emotebar--open' : ''}`}>
      {open && (
        <div className="emotebar__palette" role="menu" aria-label={t('emote.paletteLabel')}>
          {EMOTE_CATEGORIES.map((cat) => (
            <div key={cat} className="emotebar__group">
              <span className="emotebar__grouplabel dim">{t(`emote.cat.${cat}`)}</span>
              <div className="emotebar__row">
                {EMOTES.filter((e) => e.category === cat).map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className="emotebar__opt"
                    role="menuitem"
                    aria-label={t(e.i18nKey)}
                    title={t(e.i18nKey)}
                    disabled={!connected}
                    onClick={() => pick(e.id)}
                  >
                    <span aria-hidden="true">{e.emoji}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="emotebar__toggle"
        aria-expanded={open}
        aria-label={t('emote.open')}
        onClick={() => {
          primeAudio();
          setOpen((o) => !o);
        }}
      >
        <span aria-hidden="true">{open ? '✕' : '😊'}</span>
      </button>
    </div>
  );
}
