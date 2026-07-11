/**
 * Inline-SVG playing cards for the 36-card Huutopussi deck (A 10 K Q J 9 8 7 6
 * in four suits): corner indices + suit pips, four-colour (♥ red, ♦ blue,
 * ♣ green, ♠ black). Pure presentational — no i18n, no store. `CardBack` is the
 * facedown counterpart.
 */
import { type Card, type Rank, rankOf, type Suit, suitOf } from '@hp/engine';
import { useId } from 'react';

const SUIT_GLYPH: Record<Suit, string> = { H: '♥', D: '♦', C: '♣', S: '♠' };

/** Four-colour deck classification, one distinct colour per suit. */
export type SuitColor = 'red' | 'blue' | 'green' | 'black';

const SUIT_COLOR: Record<Suit, SuitColor> = { H: 'red', D: 'blue', C: 'green', S: 'black' };

/** On-card-face fill per colour (var + hex fallback), tuned for the cream face. */
const COLOR_FILL: Record<SuitColor, string> = {
  red: 'var(--card-red, #c8102e)',
  blue: 'var(--card-blue, #1667c8)',
  green: 'var(--card-green, #147a3c)',
  black: 'var(--card-black, #1a1a24)',
};

export function suitColor(suit: Suit): SuitColor {
  return SUIT_COLOR[suit];
}

/** Center pip coordinates (viewBox 100×140) for the numeric ranks. */
const PIP_LAYOUT: Partial<Record<Rank, ReadonlyArray<readonly [number, number]>>> = {
  '6': [
    [35, 44],
    [35, 72],
    [35, 100],
    [65, 44],
    [65, 72],
    [65, 100],
  ],
  '7': [
    [35, 44],
    [35, 72],
    [35, 100],
    [65, 44],
    [65, 72],
    [65, 100],
    [50, 58],
  ],
  '8': [
    [35, 44],
    [35, 72],
    [35, 100],
    [65, 44],
    [65, 72],
    [65, 100],
    [50, 58],
    [50, 86],
  ],
  '9': [
    [35, 40],
    [35, 61],
    [35, 83],
    [35, 104],
    [65, 40],
    [65, 61],
    [65, 83],
    [65, 104],
    [50, 72],
  ],
  '10': [
    [35, 40],
    [35, 61],
    [35, 83],
    [35, 104],
    [65, 40],
    [65, 61],
    [65, 83],
    [65, 104],
    [50, 51],
    [50, 93],
  ],
};

export interface CardFaceProps {
  card: Card;
  /** CSS width; defaults to the --card-w token. */
  width?: number | string;
}

export function CardFace({ card, width }: CardFaceProps) {
  const suit = suitOf(card);
  const rank = rankOf(card);
  const glyph = SUIT_GLYPH[suit];
  const color = suitColor(suit);
  const fill = COLOR_FILL[color];
  const pips = PIP_LAYOUT[rank];
  const isCourt = rank === 'K' || rank === 'Q' || rank === 'J';

  return (
    <svg
      viewBox="0 0 100 140"
      role="img"
      aria-label={card}
      data-card={card}
      data-color={color}
      style={{ width: width ?? 'var(--card-w)', height: 'auto', display: 'block' }}
    >
      <rect
        x="1.5"
        y="1.5"
        width="97"
        height="137"
        rx="9"
        fill="var(--card-face, #fdfbf4)"
        stroke="var(--card-border, #1a1a24)"
        strokeWidth="3"
      />
      {/* Corner indices (top-left + rotated bottom-right) */}
      {[false, true].map((flip) => (
        <g key={flip ? 'br' : 'tl'} transform={flip ? 'rotate(180 50 70)' : undefined}>
          <text
            x="13"
            y="24"
            textAnchor="middle"
            fontSize="20"
            fontWeight="700"
            fontFamily="Georgia, serif"
            fill={fill}
          >
            {rank}
          </text>
          <text x="13" y="42" textAnchor="middle" fontSize="17" fill={fill}>
            {glyph}
          </text>
        </g>
      ))}
      {/* Center: ace pip / court letter / numeric pip grid */}
      {rank === 'A' && (
        <text x="50" y="86" textAnchor="middle" fontSize="48" fill={fill}>
          {glyph}
        </text>
      )}
      {isCourt && (
        <>
          <text
            x="50"
            y="78"
            textAnchor="middle"
            fontSize="42"
            fontWeight="700"
            fontFamily="Georgia, serif"
            fill={fill}
          >
            {rank}
          </text>
          <text x="50" y="106" textAnchor="middle" fontSize="20" fill={fill}>
            {glyph}
          </text>
        </>
      )}
      {pips?.map(([x, y]) => (
        <text key={`${x}-${y}`} x={x} y={y + 7} textAnchor="middle" fontSize="20" fill={fill}>
          {glyph}
        </text>
      ))}
    </svg>
  );
}

export interface CardBackProps {
  /** CSS width; defaults to the --card-w token. */
  width?: number | string;
}

export function CardBack({ width }: CardBackProps) {
  const patternId = useId();
  return (
    <svg
      viewBox="0 0 100 140"
      role="img"
      aria-label="card back"
      data-card="back"
      style={{ width: width ?? 'var(--card-w)', height: 'auto', display: 'block' }}
    >
      <defs>
        <pattern id={patternId} width="14" height="14" patternUnits="userSpaceOnUse">
          <rect width="14" height="14" fill="var(--card-back, #0b3d2e)" />
          <path
            d="M0 7 L7 0 L14 7 L7 14 Z"
            fill="none"
            stroke="var(--gold-soft, #b9975b)"
            strokeWidth="1.2"
            opacity="0.55"
          />
        </pattern>
      </defs>
      <rect
        x="1.5"
        y="1.5"
        width="97"
        height="137"
        rx="9"
        fill="var(--card-back, #0b3d2e)"
        stroke="var(--card-border, #1a1a24)"
        strokeWidth="3"
      />
      <rect x="8" y="8" width="84" height="124" rx="5" fill={`url(#${patternId})`} />
      <rect
        x="8"
        y="8"
        width="84"
        height="124"
        rx="5"
        fill="none"
        stroke="var(--gold, #d4af37)"
        strokeWidth="1.5"
      />
    </svg>
  );
}
