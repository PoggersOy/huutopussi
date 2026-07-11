/** CardFace renders every card of the 36-card deck; CardBack renders. */
import { makeDeck, rankOf, type Suit, suitOf } from '@hp/engine';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CardBack, CardFace } from '../src/components/CardFace';

// Four-colour deck (poker standard): ♥ red, ♦ blue, ♣ green, ♠ black.
const EXPECTED_COLOR: Record<Suit, string> = { H: 'red', D: 'blue', C: 'green', S: 'black' };

describe('CardFace', () => {
  it('renders all 36 cards with the right color and rank text', () => {
    const deck = makeDeck();
    expect(deck).toHaveLength(36);

    const { container } = render(
      <div>
        {deck.map((card) => (
          <CardFace key={card} card={card} />
        ))}
      </div>,
    );

    for (const card of deck) {
      const el = container.querySelector(`[data-card="${card}"]`);
      expect(el, card).not.toBeNull();
      const suit = suitOf(card);
      expect(el?.getAttribute('data-color'), card).toBe(EXPECTED_COLOR[suit]);
      expect(el?.textContent, card).toContain(rankOf(card));
    }
    expect(container.querySelectorAll('svg[data-card]')).toHaveLength(36);
  });

  it('CardBack renders a facedown card', () => {
    const { container } = render(<CardBack />);
    expect(container.querySelector('[data-card="back"]')).not.toBeNull();
  });
});
