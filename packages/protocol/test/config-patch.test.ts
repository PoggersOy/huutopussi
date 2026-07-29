import { ILLISOFT_RULES } from '@hp/engine';
import { describe, expect, it } from 'vitest';
import { configPatchSchema } from '../src/index.js';

describe('configPatchSchema', () => {
  it('exposes every RuleConfig field on the wire', () => {
    expect([...configPatchSchema.keyof().options].sort()).toEqual(
      Object.keys(ILLISOFT_RULES).sort(),
    );
  });

  it('accepts the bid-step, first-bidder and half-ask variations', () => {
    expect(
      configPatchSchema.parse({
        bidStep: 10,
        firstBidder: 'dealer',
        askHalfMustHoldCard: false,
      }),
    ).toEqual({
      bidStep: 10,
      firstBidder: 'dealer',
      askHalfMustHoldCard: false,
    });
  });
});
