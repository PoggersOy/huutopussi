/**
 * Hidden information: with 4 seated clients + 1 spectator playing a full deal,
 * no update/welcome message serialized to seat X may ever contain a card that
 * is currently in seat Y's hand (regex over the serialized JSON), and
 * TurnInfo.hints must never reach anyone but the acting seat.
 *
 * "Currently in Y's hand" is reconstructed from Y's OWN per-seq hand reports
 * (every recipient receives every seq), exactly like the engine fuzz check.
 * Legitimately privy fields are excluded: the viewer's own hand, and the
 * exchange faces for the two exchanging seats.
 */
import type { Seat } from '@hp/engine';
import type { ServerMsg } from '@hp/protocol';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer, type HpServer } from '../src/index.js';
import { attachDriver, seatFourHumans, TestClient, waitForDealScored } from './helpers.js';

let server: HpServer;
let port: number;

beforeAll(async () => {
  server = createServer({
    port: 0,
    dbPath: ':memory:',
    heartbeatMs: null,
    timers: { turnMs: 20_000, botDelayMs: [0, 1], nextDealDelayMs: 60_000 },
  });
  port = await server.listen();
});

afterAll(async () => {
  await server.close();
});

/** Matches any JSON-quoted card token, e.g. "H10", "SQ". */
const CARD_TOKEN_RE = /"([HDCS](?:10|[AKQJ6-9]))"/g;

type Scannable = Extract<ServerMsg, { t: 'update' | 'welcome' }>;

/** seat -> ascending [seq, own hand at that seq] reports. */
function handTimelines(clients: TestClient[]): Map<Seat, Array<[number, Set<string>]>> {
  const timelines = new Map<Seat, Array<[number, Set<string>]>>();
  for (const c of clients) {
    if (c.seat === null) continue;
    const entries: Array<[number, Set<string>]> = [];
    for (const m of c.messages) {
      if ((m.t === 'update' || m.t === 'welcome') && m.view?.deal) {
        entries.push([m.seq, new Set(m.view.deal.hand)]);
      }
    }
    timelines.set(c.seat, entries);
  }
  return timelines;
}

function handAt(timeline: Array<[number, Set<string>]> | undefined, seq: number): Set<string> {
  if (!timeline) return new Set();
  let best: Set<string> = new Set();
  for (const [s, hand] of timeline) {
    if (s > seq) break;
    best = hand;
  }
  return best;
}

/** Deep-clones msg and strips ONLY fields the viewer is legitimately privy to. */
function scannableJson(msg: Scannable, viewerSeat: Seat | null): string {
  const clone = JSON.parse(JSON.stringify(msg)) as {
    view: {
      deal: { hand?: unknown; exchangeSeen?: unknown; declarer?: number | null } | null;
    } | null;
    event?: { type?: string; from?: number; to?: number; cards?: unknown } | null;
    turn?: { hints?: unknown } | null;
  };
  if (clone.view?.deal) {
    // The viewer's own hand is theirs to see.
    clone.view.deal.hand = [];
    // Exchange faces are privy ONLY to declarer + partner; for anyone else a
    // non-null exchangeSeen would itself be a leak, so keep it in the scan.
    const declarer = clone.view.deal.declarer;
    const privy =
      viewerSeat !== null &&
      declarer !== null &&
      declarer !== undefined &&
      (viewerSeat === declarer || viewerSeat === (declarer + 2) % 4);
    if (privy) clone.view.deal.exchangeSeen = null;
  }
  const ev = clone.event;
  if (
    ev &&
    (ev.type === 'cardsGiven' || ev.type === 'cardsReturned') &&
    viewerSeat !== null &&
    (ev.from === viewerSeat || ev.to === viewerSeat)
  ) {
    ev.cards = [];
  }
  // Hints are only ever the viewer's own legal moves (asserted separately);
  // leave them in the scan so foreign cards in hints would still be caught.
  return JSON.stringify(clone);
}

test("no message ever leaks another seat's hand; hints only to the actor", async () => {
  const clients = await seatFourHumans(port);
  const host = clients[0] as TestClient;

  const spectator = await TestClient.connect(port);
  const sw = await spectator.hello({ roomCode: host.roomCode, nickname: 'peeper' });
  expect(sw.t).toBe('welcome');
  expect(spectator.seat).toBeNull();

  for (const c of clients) attachDriver(c);

  const everyone = [...clients, spectator];
  const scoredSeen = everyone.map((c) => waitForDealScored(c));
  host.lobby({ type: 'startMatch' });
  await Promise.all(scoredSeen);

  const timelines = handTimelines(clients);
  const violations: string[] = [];

  for (const c of everyone) {
    const viewerSeat = c.seat;
    for (const m of c.messages) {
      if (m.t !== 'update' && m.t !== 'welcome') continue;

      // Hints strictly to the acting seat; spectators never get hints.
      if (m.turn && m.turn.hints !== null) {
        if (viewerSeat === null || m.turn.seat !== viewerSeat) {
          violations.push(
            `hints for seat ${m.turn.seat} delivered to viewer ${String(viewerSeat)}`,
          );
        }
      }
      if (viewerSeat === null && m.view?.deal && m.view.deal.hand.length > 0) {
        violations.push('spectator view contains a hand');
      }

      const json = scannableJson(m as Scannable, viewerSeat);
      for (const match of json.matchAll(CARD_TOKEN_RE)) {
        const card = match[1] as string;
        for (const other of [0, 1, 2, 3] as Seat[]) {
          if (other === viewerSeat) continue;
          if (handAt(timelines.get(other), m.seq).has(card)) {
            violations.push(
              `msg seq ${m.seq} (${m.t}) to viewer ${String(viewerSeat)} leaks ${card} held by seat ${other}`,
            );
          }
        }
      }
    }
  }

  expect(violations).toEqual([]);

  // Sanity: the scan had teeth — plenty of messages and card tokens flowed.
  const scanned = everyone.flatMap((c) => c.messages.filter((m) => m.t === 'update'));
  expect(scanned.length).toBeGreaterThan(100);

  for (const c of everyone) c.close();
});
