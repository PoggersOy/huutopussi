/**
 * Offline match driver for the learning modes (tutorial + puzzles). Runs the
 * pure @hp/engine ENTIRELY in the browser — no server, no socket — and writes
 * the SAME `welcome`/`update` shapes into the store that the real socket layer
 * writes, so the whole Table UI (hands, sheets, bubbles, trick flash, sound/
 * haptics, läpäri animation) works unchanged.
 *
 * It mirrors the server's action loop exactly (see server.ts submitAction /
 * applyAndBroadcast): validateAction → check isRuleError → fold applyEvent →
 * broadcast ONE update carrying the FIRST event of the chain + the final view.
 * Opponents are driven by a deterministic teaching actor (below), so a scenario
 * always plays out the same way given the same human choices.
 *
 * socket.ts routes sendAction/sendLobby here while `isLearnActive()`.
 */
import {
  type ActionHint,
  activeSeats,
  allowedActions,
  applyEvent,
  type Card,
  expectedActor,
  type GameEvent,
  initialMatchState,
  isRuleError,
  type MatchState,
  nextDealEvent,
  type PlayerAction,
  type PlayerView,
  rankIndex,
  rankOf,
  redactEventFor,
  redactViewFor,
  type Seat,
  type Side,
  sideOf,
  validateAction,
} from '@hp/engine';
import type { RoomStatePublic, SeatInfo, ServerMsg, TurnInfo } from '@hp/protocol';
import type { Scenario } from './scenarios';
import { serverApply, useStore } from './store';

/** Beat between each opponent move so the table animates one action at a time. */
const OPP_DELAY_MS = 650;

let scenario: Scenario | null = null;
let state: MatchState | null = null;
let human: Seat = 0;
let seq = 0;
/** Bumped on every start/stop so stale scheduled callbacks are ignored. */
let generation = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();

export function isLearnActive(): boolean {
  return scenario !== null;
}

function schedule(fn: () => void, ms: number): void {
  const gen = generation;
  const id = setTimeout(() => {
    timers.delete(id);
    if (gen === generation) fn();
  }, ms);
  timers.add(id);
}

function clearTimers(): void {
  for (const id of timers) clearTimeout(id);
  timers.clear();
}

function humanSide(): Side {
  return sideOf(human, (state as MatchState).config.players);
}

function savedNick(): string | null {
  try {
    const n = localStorage.getItem('hp:nickname')?.trim();
    return n && n.length > 0 ? n : null;
  } catch {
    return null;
  }
}

/** A synthetic public room: the human at their seat, the rest "bots". */
function makeRoom(s: MatchState): RoomStatePublic {
  const cfg = s.config;
  const nick = savedNick();
  const seats: SeatInfo[] = activeSeats(cfg.players).map((seat) =>
    seat === human
      ? { seat, nickname: nick, kind: 'human', connected: true, botControlled: false }
      : { seat, nickname: null, kind: 'bot', connected: true, botControlled: false },
  );
  return {
    code: 'OPPI',
    seats,
    hostSeat: human,
    config: cfg,
    configName: null,
    tableSettings: { autoplay: false, turnTimeoutSec: 120 },
    status: 'playing',
    matchmaking: null,
  };
}

function turnFor(s: MatchState): TurnInfo | null {
  const actor = expectedActor(s);
  if (actor === null) return null;
  // Hidden-info rule preserved: hints only ever go to the acting seat, and here
  // the only recipient is the human.
  return { seat: actor, deadline: null, hints: actor === human ? allowedActions(s, human) : null };
}

/** Push one snapshot to the store, exactly like a server `update`. */
function emit(s: MatchState, trigger: GameEvent | null): void {
  seq += 1;
  serverApply.update({
    t: 'update',
    seq,
    view: redactViewFor(s, human),
    event: trigger !== null ? redactEventFor(trigger, human) : null,
    turn: turnFor(s),
  });
}

/**
 * Deterministic teaching opponent: never bids (unless forced), never declares a
 * marriage, and plays its WEAKEST legal card — so the human keeps the
 * initiative and scenarios stay reproducible. Handles every mandatory hint type.
 * Exported for the scenario winnability test (test/scenarios.test.ts).
 */
export function teachAction(view: PlayerView, hints: ActionHint[]): PlayerAction {
  const hand: readonly Card[] = view.deal?.hand ?? [];
  for (const h of hints) {
    switch (h.type) {
      case 'bid':
        return h.forced ? { type: 'bid', amount: h.min } : { type: 'pass' };
      case 'giveCards':
        return { type: 'giveCards', cards: hand.slice(0, h.count) };
      case 'discardCards':
        return { type: 'discardCards', cards: h.legal.slice(0, h.count) };
      case 'setContract':
        return { type: 'setContract', amount: h.min };
      case 'returnCards':
        return { type: 'returnCards', cards: hand.slice(0, h.count) };
      case 'answerWhole': {
        const suit = h.suits[0];
        if (suit !== undefined) return { type: 'answerWhole', suit };
        break;
      }
      default:
        break;
    }
  }
  const play = hints.find(
    (h): h is Extract<ActionHint, { type: 'playCard' }> => h.type === 'playCard',
  );
  if (play !== undefined) {
    // Weakest legal card: highest rank INDEX (A=0 … 6=8 ⇒ larger = weaker).
    const weakest = [...play.legal].sort((a, b) => rankIndex(rankOf(b)) - rankIndex(rankOf(a)))[0];
    if (weakest !== undefined) return { type: 'playCard', card: weakest };
  }
  throw new Error('teachAction: no mandatory move found in hints');
}

/** Apply a validated action for `seat`, emit the snapshot, then drive on. */
function applyAction(seat: Seat, action: PlayerAction): void {
  if (state === null) return;
  const res = validateAction(state, seat, action);
  if (isRuleError(res)) {
    // Only the human sees rejections (a mis-tap); the scripted opponents never
    // produce illegal moves. Surface it as the usual error toast.
    if (seat === human) {
      serverApply.error(
        res.params !== undefined
          ? { t: 'error', code: res.code, params: res.params }
          : { t: 'error', code: res.code },
      );
    }
    return;
  }
  let next = state;
  for (const e of res) next = applyEvent(next, e);
  state = next;
  emit(next, res[0] ?? null);
  onProgress(next);
  advance();
}

/** After each change: if the deal is scored, mark the session complete + judge. */
function onProgress(s: MatchState): void {
  if (s.deal === null || s.deal.phase.name !== 'scored') return;
  const result = s.deal.phase.result;
  const sess = useStore.getState().ui.learn;
  if (sess === null || sess.status === 'complete') return;
  const won = scenario?.goal !== undefined ? scenario.goal(result, humanSide()) : null;
  useStore.getState().setLearn({ ...sess, status: 'complete', won });
}

/** Drive the opponents until it's the human's turn (or the deal is over). */
function advance(): void {
  if (state === null) return;
  const actor = expectedActor(state);
  if (actor === null || actor === human) return;
  schedule(() => {
    if (state === null) return;
    const view = redactViewFor(state, actor);
    const hints = allowedActions(state, actor);
    applyAction(actor, teachAction(view, hints));
  }, OPP_DELAY_MS);
}

// ── Public API (called by the Learn screen + socket.ts) ──────────────────────

/** Begin a scenario: build the deal, seed the store, and drive to the human. */
export function startLearn(sc: Scenario): void {
  stopLearn();
  generation += 1;
  scenario = sc;
  human = sc.humanSeat;
  seq = 0;
  let s = initialMatchState(sc.config, sc.firstDealer);
  s = applyEvent(s, nextDealEvent(s, sc.deck));
  state = s;
  // Seed the learn session BEFORE the welcome (welcome preserves `ui.learn`).
  useStore.getState().setLearn({
    scenarioId: sc.id,
    kind: sc.kind,
    topic: sc.topic,
    status: 'playing',
    won: null,
  });
  const welcome: Extract<ServerMsg, { t: 'welcome' }> = {
    t: 'welcome',
    v: 0,
    sessionToken: '',
    room: makeRoom(s),
    seat: human,
    seq: 0,
    view: redactViewFor(s, human),
    turn: turnFor(s),
  };
  serverApply.welcome(welcome);
  advance();
}

/** Tear down the driver internals (timers + state). Store teardown is separate. */
export function stopLearn(): void {
  clearTimers();
  generation += 1;
  scenario = null;
  state = null;
  seq = 0;
}

/** Full exit: stop the driver AND wipe the store back to a clean slate. */
export function exitLearn(): void {
  stopLearn();
  serverApply.reset();
}

/** A human action from the Table (routed here by socket.ts while learning). */
export function submitLearnAction(action: PlayerAction): void {
  applyAction(human, action);
}
