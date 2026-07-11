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

/** Jewel/pearl accent (matches the card back's gold) and the cream face cut-out. */
const GOLD = 'var(--gold, #d4af37)';
const CREAM = 'var(--card-face, #fdfbf4)';

/**
 * Central court emblem, drawn in the suit colour with gold jewels — a regal
 * crown for the King, a softer pearled coronet for the Queen, a plumed
 * soldier's helmet for the Jack. Centered at x=50 in the 100×140 viewBox so it
 * clears the corner indices; the caller adds the suit glyph beneath it.
 */
function CourtEmblem({ rank, fill }: { rank: 'K' | 'Q' | 'J'; fill: string }) {
  if (rank === 'K') {
    return (
      <>
        {/* imperial cross above the centre peak */}
        <rect x="48.7" y="30" width="2.6" height="12" rx="1" fill={fill} />
        <rect x="45" y="33.2" width="10" height="2.6" rx="1" fill={fill} />
        {/* crown + band */}
        <path d="M26 82 L30 54 L40 70 L50 44 L60 70 L70 54 L74 82 Z" fill={fill} />
        <rect x="25" y="80" width="50" height="13" rx="3.5" fill={fill} />
        {/* jewels on the peaks and a diamond on the band */}
        <circle cx="30" cy="53" r="3.4" fill={GOLD} />
        <circle cx="50" cy="43" r="3.8" fill={GOLD} />
        <circle cx="70" cy="53" r="3.4" fill={GOLD} />
        <rect
          x="46.5"
          y="82.5"
          width="7"
          height="7"
          rx="1.5"
          transform="rotate(45 50 86)"
          fill={GOLD}
        />
      </>
    );
  }
  if (rank === 'Q') {
    return (
      <>
        {/* three rounded arches over a band */}
        <rect x="28" y="80" width="44" height="12" rx="4" fill={fill} />
        <path d="M30 82 Q30 66 38 66 Q46 66 46 82 Z" fill={fill} />
        <path d="M42 82 Q42 60 50 60 Q58 60 58 82 Z" fill={fill} />
        <path d="M54 82 Q54 66 62 66 Q70 66 70 82 Z" fill={fill} />
        {/* pearls on the arch tips and a jewel on the band */}
        <circle cx="38" cy="64" r="3.2" fill={GOLD} />
        <circle cx="50" cy="57" r="3.6" fill={GOLD} />
        <circle cx="62" cy="64" r="3.2" fill={GOLD} />
        <circle cx="50" cy="86" r="3.4" fill={GOLD} />
      </>
    );
  }
  // Jack — soldier's helmet with a swept-back horsehair crest
  return (
    <>
      <path d="M40 56 Q42 40 52 40 Q60 40 59 50 Q58 58 50 58 Q44 58 40 56 Z" fill={fill} />
      <path d="M36 84 Q36 58 50 58 Q64 58 64 84 Z" fill={fill} />
      <rect x="35" y="82" width="30" height="9" rx="3" fill={fill} />
      <circle cx="52" cy="58" r="3" fill={GOLD} />
      {/* visor slit + breathing holes cut from the cream face */}
      <rect x="40" y="70" width="20" height="4" rx="2" fill={CREAM} />
      <circle cx="44" cy="79" r="1.3" fill={CREAM} />
      <circle cx="50" cy="79" r="1.3" fill={CREAM} />
      <circle cx="56" cy="79" r="1.3" fill={CREAM} />
    </>
  );
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
      {/* Center: ace pip / court emblem + glyph / numeric pip grid */}
      {rank === 'A' && (
        <text x="50" y="86" textAnchor="middle" fontSize="48" fill={fill}>
          {glyph}
        </text>
      )}
      {isCourt && (
        <>
          <CourtEmblem rank={rank as 'K' | 'Q' | 'J'} fill={fill} />
          <text x="50" y="112" textAnchor="middle" fontSize="18" fill={fill}>
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

export interface CardStackProps {
  /** How many cards the pile holds — shown as stacked, peeking card edges. */
  count: number;
  /** CSS width of a single card; defaults to the --card-w token. */
  width?: number | string;
  /**
   * Cap on how many card backs are actually drawn. A tall pile (e.g. a dead
   * hand of 11) reads as "many cards" from a handful of stacked edges without
   * literally rendering every card. Small piles (≤ cap) render exactly.
   */
  maxLayers?: number;
}

/**
 * A facedown pile drawn as a heap of offset {@link CardBack}s so its depth is
 * visible at a glance. Cards run along a short down-and-right diagonal; the
 * fully-visible top card sits in the MIDDLE of that spread, so buried edges peek
 * out on both sides of it and it reads as one pile rather than a lone card with
 * a stack beside it. The count itself is shown by the caller's label.
 */
const STACK_STEP = 2; // px each card is offset from its neighbour along the pile

export function CardStack({ count, width, maxLayers = 6 }: CardStackProps) {
  const layers = Math.max(1, Math.min(Math.floor(count), maxLayers));
  const spread = (layers - 1) * STACK_STEP;
  // The crisp, on-top card is the middle one so the pile is balanced.
  const topIndex = Math.round((layers - 1) / 2);
  const backProps = width !== undefined ? { width } : {};
  const pos = (k: number) => `translate(${k * STACK_STEP}px, ${k * STACK_STEP}px)`;
  return (
    // Reserve room for the peeking edges so the pile stays a self-contained box
    // — the caller's count label sits clear to its right.
    <span className="card-stack" style={{ paddingRight: spread, paddingBottom: spread }}>
      {Array.from({ length: layers }, (_, k) => k)
        .filter((k) => k !== topIndex)
        .map((k) => (
          <span
            key={k}
            className="card-stack__layer"
            aria-hidden="true"
            style={{ transform: pos(k) }}
          >
            <CardBack {...backProps} />
          </span>
        ))}
      <span className="card-stack__top" style={{ transform: pos(topIndex) }}>
        <CardBack {...backProps} />
      </span>
    </span>
  );
}
