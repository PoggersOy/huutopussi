/**
 * Shared E2E helpers: lobby flows + a generic "act on whatever the server
 * allows" UI driver. The driver NEVER derives legality itself — it only taps
 * UI elements the client enabled from server-sent ActionHints (disabled cards
 * and buttons are never touched), mirroring how a human plays.
 *
 * Driving policy (deterministic, per DriverState):
 *  - bidding: bid the sheet's minimum once, then pass whenever passing is
 *    offered; when passing is not offered (forced opening), bid the minimum.
 *  - exchange give/return: tap-select cards in the fan until the exact-count
 *    Confirm button enables, then confirm.
 *  - contract: announce the minimum.
 *  - declarations: always "Just lead" (skip declaring).
 *  - answer-whole: reveal the first offered marriage.
 *  - trick play: two-step tap (raise, then play) on the first enabled card.
 */
import { devices, expect, type Locator, type Page } from '@playwright/test';

/**
 * The client defaults to Finnish (persisted `hp:lang` toggle, no browser-locale
 * sniffing since the i18n change), so every E2E context pre-seeds that toggle to
 * English — the language every spec asserts against. Consumed by the project
 * `use` in playwright.config.ts and by the manual contexts below. The origin
 * MUST match playwright.config.ts BASE_URL.
 */
export const englishStorageState = {
  cookies: [],
  origins: [{ origin: 'http://127.0.0.1:8197', localStorage: [{ name: 'hp:lang', value: 'en' }] }],
};

// Device options for manually-created contexts (two-humans test). The device
// descriptor's defaultBrowserType (webkit) is dropped — projects run chromium.
const { defaultBrowserType: _ignored, ...iphone14 } = devices['iPhone 14'];
export const mobileContextOptions = {
  ...iphone14,
  locale: 'en-US',
  storageState: englishStorageState,
};

export interface DriverState {
  /** True once this player has placed their one voluntary bid. */
  hasBid: boolean;
}

export interface Driver {
  page: Page;
  state: DriverState;
}

export function newDriver(page: Page): Driver {
  return { page, state: { hasBid: false } };
}

// ── Lobby flows ──────────────────────────────────────────────────────────────

/** Home → nickname → "Create a room" → lobby. Returns the room code. */
export async function createRoom(page: Page, nickname: string): Promise<string> {
  await page.goto('/');
  await page.getByPlaceholder('Your name').fill(nickname);
  await page.getByRole('button', { name: 'Create a room', exact: true }).click();
  await page.waitForURL(/\/r\/[A-HJ-NP-Z2-9]{5}$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Lobby', exact: true })).toBeVisible();
  const code = page.url().split('/r/')[1];
  if (code === undefined) throw new Error(`no room code in url ${page.url()}`);
  return code;
}

/** Home → nickname → room code → "Join" → lobby of that room. */
export async function joinRoomViaHome(page: Page, code: string, nickname: string): Promise<void> {
  await page.goto('/');
  await page.getByPlaceholder('Your name').fill(nickname);
  await page.getByPlaceholder('Room code').fill(code);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.waitForURL(`**/r/${code}`, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Lobby', exact: true })).toBeVisible();
}

/** Host-only: fill `count` empty seats with bots (front-to-back DOM order). */
export async function addBots(page: Page, count: number): Promise<void> {
  const addButtons = page.getByRole('button', { name: 'Add a bot', exact: true });
  for (let i = 0; i < count; i++) {
    const before = await addButtons.count();
    await addButtons.first().click();
    await expect(addButtons).toHaveCount(before - 1);
  }
}

/**
 * Host-only: choose a rules preset in the lobby config panel and wait for the
 * server to apply it. The product default is illisoft; tests that assert the
 * päämuoto point system (130-point deals, forced opening) must pin it here.
 */
export async function setPreset(page: Page, preset: 'paamuoto' | 'illisoft'): Promise<void> {
  const select = page.locator('select:has(option[value="paamuoto"])');
  await select.selectOption(preset);
  // The select value is React-controlled from the server config echo, so this
  // also confirms the setConfig patch round-tripped and was accepted.
  await expect(select).toHaveValue(preset);
}

export async function startMatch(page: Page): Promise<void> {
  const start = page.getByRole('button', { name: 'Start the game', exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.locator('main.felt')).toBeVisible({ timeout: 20_000 });
}

// ── Low-level utilities ──────────────────────────────────────────────────────

async function tryClick(loc: Locator): Promise<boolean> {
  try {
    await loc.first().click({ timeout: 1_500 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Tap a hand-fan card on its VISIBLE LEFT SLIVER, not its centre. The portrait
 * fan overlaps cards by 62 % (.hand--dense) to 74 % (.hand--xdense) so they fit,
 * which means a card's centre is covered by the neighbour stacked on top of it —
 * a default (centre) click is intercepted by that neighbour and times out. Each
 * card's left edge is on top of (and clear of) its neighbours, so that is where
 * a human taps and where we click. Mirrors tryClick's swallow-and-retry.
 */
async function tapCard(loc: Locator): Promise<boolean> {
  try {
    await loc.first().click({ position: { x: 5, y: 24 }, timeout: 1_500 });
    return true;
  } catch {
    return false;
  }
}

async function firstEnabled(loc: Locator): Promise<Locator | null> {
  const el = loc.first();
  if ((await el.count()) === 0) return null;
  const enabled = await el.isEnabled().catch(() => false);
  return enabled ? el : null;
}

/** The viewer's own hand, in display order (card codes like 'HA', 'S10'). */
export async function ownHand(page: Page): Promise<string[]> {
  return await page
    .locator('footer .hand__card svg[data-card]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-card') ?? ''));
}

/** Top-bar running match totals as seen by this viewer. */
export async function topScores(page: Page): Promise<{ us: number; them: number }> {
  const text = await page.locator('.ttop__row').first().innerText();
  const us = /Us\s+(-?\d+)/.exec(text);
  const them = /Them\s+(-?\d+)/.exec(text);
  if (us?.[1] === undefined || them?.[1] === undefined) {
    throw new Error(`could not parse scores from top bar: ${JSON.stringify(text)}`);
  }
  return { us: Number.parseInt(us[1], 10), them: Number.parseInt(them[1], 10) };
}

// ── The driver ───────────────────────────────────────────────────────────────

/**
 * Perform at most ONE currently-available legal action on this page.
 * Safe to call at any time: when nothing is actionable it does nothing.
 */
export async function actOnce(page: Page, state: DriverState): Promise<void> {
  // Never act under an overlay (deal scored / match ended) or while our
  // previous action is still pending (raised-card spinner).
  if (await page.locator('.overlay').count()) return;
  if (await page.locator('.hand__spinner').count()) return;

  const sheet = page.locator('.tsheet');
  if (await sheet.count()) {
    // Bidding: bid the minimum once, then pass; bid again only when forced
    // (no Pass offered, e.g. forced opening — also after a redeal).
    const bidBtn = await firstEnabled(sheet.getByRole('button', { name: /^Bid \d+$/ }));
    const passBtn = await firstEnabled(sheet.getByRole('button', { name: 'Pass', exact: true }));
    if (bidBtn !== null || passBtn !== null) {
      if (passBtn !== null && (state.hasBid || bidBtn === null)) {
        await tryClick(passBtn);
      } else if (bidBtn !== null) {
        if (await tryClick(bidBtn)) state.hasBid = true;
      }
      return;
    }

    // Contract: announce the minimum the stepper starts at.
    const contractBtn = await firstEnabled(
      sheet.getByRole('button', { name: /^Announce contract \d+$/ }),
    );
    if (contractBtn !== null) {
      await tryClick(contractBtn);
      return;
    }

    // Exchange give/return: the Confirm button exists only for the actor.
    const confirmBtn = sheet.getByRole('button', { name: /^Confirm/ });
    if (await confirmBtn.count()) {
      if (await confirmBtn.first().isEnabled()) {
        await tryClick(confirmBtn);
      } else {
        // Select one more card in the fan (all cards are tappable toggles here).
        const unpicked = page.locator('footer .hand__card:not(.hand__card--picked)');
        if (await unpicked.count()) await tapCard(unpicked.first());
      }
      return;
    }

    // Declaration opportunity: skip it — just lead a card.
    const justLead = await firstEnabled(
      sheet.getByRole('button', { name: 'Just lead', exact: true }),
    );
    if (justLead !== null) {
      await tryClick(justLead);
      return;
    }

    // Answer a whole-marriage ask: reveal the first offered suit.
    const gridChoice = await firstEnabled(sheet.locator('.tsheet__grid button'));
    if (gridChoice !== null) {
      await tryClick(gridChoice);
      return;
    }

    return; // sheet is informational for us right now (waiting note)
  }

  // No sheet: if it is our turn to play a card, two-step tap a legal one.
  if (await page.locator('footer.thand--turn').count()) {
    await playAnyLegalCard(page);
  }
}

/**
 * Two-step play: raise the first ENABLED (= server-hinted legal) card, then
 * tap it again to play. Tolerant of state moving underneath — a failed step
 * simply leaves the next driver iteration to retry.
 */
async function playAnyLegalCard(page: Page): Promise<void> {
  const enabled = page.locator('footer .hand__card:not([disabled])');
  if ((await enabled.count()) === 0) return;
  const card = await enabled
    .first()
    .locator('svg')
    .getAttribute('data-card')
    .catch(() => null);
  if (card === null) return;
  // Pin the button by card code so re-renders between taps cannot swap cards.
  const btn = page.locator(`footer .hand__card:has(svg[data-card="${card}"])`);
  if (!(await tapCard(btn))) return; // raise
  try {
    await expect(btn).toHaveClass(/hand__card--raised/, { timeout: 1_000 });
  } catch {
    return; // state moved on (update lowered the card) — retry next iteration
  }
  await tapCard(btn); // play
}

/**
 * Main loop: poll `predicate`; while false, let every driver perform one
 * available action. Deterministic — succeeds as soon as the predicate holds,
 * fails loudly on timeout.
 */
export async function driveUntil(
  drivers: Driver[],
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const first = drivers[0];
  if (first === undefined) throw new Error('driveUntil needs at least one driver');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    for (const d of drivers) {
      await actOnce(d.page, d.state);
    }
    await first.page.waitForTimeout(150);
  }
  throw new Error(`driveUntil timed out after ${timeoutMs} ms: ${label}`);
}

// ── Last-trick peek (cross-client consistency checks) ────────────────────────

export interface LastTrick {
  /** Card codes in play order (server order — identical for every viewer). */
  cards: string[];
  /** cards annotated with the winner flag — a comparable trick fingerprint. */
  key: string;
}

/**
 * Read the last completed trick via the "Last trick" peek. Opens the peek
 * when needed. Returns null while unavailable (no trick yet / winner-flash
 * linger hides the peek) — callers poll.
 */
export async function tryReadLastTrick(page: Page): Promise<LastTrick | null> {
  const panel = page.locator('.peek__panel');
  if (!(await panel.isVisible().catch(() => false))) {
    const btn = page.getByRole('button', { name: 'Last trick', exact: true });
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 1_000 }).catch(() => {});
    }
    if (!(await panel.isVisible().catch(() => false))) return null;
  }
  const entries = await panel.locator('.peek__card').evaluateAll((els) =>
    els.map((el) => ({
      card: el.querySelector('svg')?.getAttribute('data-card') ?? '',
      win: el.querySelector('.peek__win') !== null,
    })),
  );
  if (entries.length === 0 || entries.some((e) => e.card === '')) return null;
  return {
    cards: entries.map((e) => e.card),
    key: entries.map((e) => `${e.card}${e.win ? '*' : ''}`).join(','),
  };
}
