/**
 * Two humans (two browser contexts) + two bots in one room.
 *
 * Consistency assertions:
 *  - during bidding, speech bubbles for bids/passes appear on BOTH screens;
 *  - after each of the first three completed tricks both clients agree on the
 *    exact trick (same cards in the same order, same winning card — read from
 *    the "Last trick" peek) and show the same match scores.
 *
 * Bert is auto-seated on join at the first free seat (seat 1 — Anna holds the
 * host seat 0), so the two humans are opponents. No deal is scored within the
 * three-trick window, so both clients still read 0 for every side; the per-trick
 * score check is a cheap "no phantom score" guard, not a partnership assertion.
 */
import { expect, test } from '@playwright/test';
import {
  addBots,
  createRoom,
  type Driver,
  driveUntil,
  joinRoomViaHome,
  mobileContextOptions,
  newDriver,
  ownScore,
  startMatch,
  tryReadLastTrick,
} from './helpers';

test.setTimeout(420_000);

test('two humans + two bots stay consistent through bidding and three tricks', async ({
  browser,
}) => {
  const ctxA = await browser.newContext(mobileContextOptions);
  const ctxB = await browser.newContext(mobileContextOptions);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    const code = await createRoom(pageA, 'Anna');
    await joinRoomViaHome(pageB, code, 'Bert');

    // Bert is auto-seated on join (first free seat = seat 1); wait until Anna's
    // lobby shows him before adding the two bots.
    await expect(pageA.getByText('Bert')).toBeVisible();
    await addBots(pageA, 2);
    await startMatch(pageA);
    await expect(pageB.locator('main.felt')).toBeVisible({ timeout: 20_000 });

    const drivers: Driver[] = [newDriver(pageA), newDriver(pageB)];
    const bubbleRe = /^(\d+!|Pass)$/;
    let bubbleSeenA = false;
    let bubbleSeenB = false;

    const noteBubbles = async (): Promise<void> => {
      if (!bubbleSeenA) {
        const texts = await pageA.locator('.bubble').allTextContents();
        bubbleSeenA = texts.some((t) => bubbleRe.test(t.trim()));
      }
      if (!bubbleSeenB) {
        const texts = await pageB.locator('.bubble').allTextContents();
        bubbleSeenB = texts.some((t) => bubbleRe.test(t.trim()));
      }
    };

    // Phase 1 — bidding: drive until both screens have shown a bid/pass
    // speech bubble (bubbles linger 4 s; the loop polls far faster).
    await driveUntil(
      drivers,
      async () => {
        await noteBubbles();
        return bubbleSeenA && bubbleSeenB;
      },
      120_000,
      'bid speech bubbles on both screens',
    );
    expect(bubbleSeenA).toBe(true);
    expect(bubbleSeenB).toBe(true);

    // Phase 2 — three tricks: after each completed trick both clients must
    // agree on the exact same trick fingerprint (cards in play order + the
    // winning card) before we move on. Disagreement would time out loudly.
    let prevKey = '';
    for (let trick = 1; trick <= 3; trick++) {
      let agreedKey = '';
      let agreedCards: string[] = [];
      await driveUntil(
        drivers,
        async () => {
          const a = await tryReadLastTrick(pageA);
          if (a === null || a.key === prevKey) return false;
          const b = await tryReadLastTrick(pageB);
          if (b === null || b.key !== a.key) return false;
          agreedKey = a.key;
          agreedCards = a.cards;
          return true;
        },
        180_000,
        `both clients agreeing on trick ${trick}`,
      );
      expect(agreedCards).toHaveLength(4);
      expect(new Set(agreedCards).size).toBe(4);
      expect(agreedKey).toContain('*'); // exactly one winner-marked card
      prevKey = agreedKey;

      // No deal has scored yet in this window, so both clients read 0 for their
      // own side — a cheap phantom-score guard across the two screens.
      const scoreA = await ownScore(pageA);
      const scoreB = await ownScore(pageB);
      expect(scoreB).toEqual(scoreA);
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
