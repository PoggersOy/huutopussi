/**
 * Zustand store, two slices (docs/plan.md §6):
 *
 *  - `server`: the authoritative mirror of what the server last sent. Written
 *    ONLY by the socket layer through the `serverApply` functions below —
 *    every `update`/`welcome` replaces the snapshot wholesale. Components
 *    never mutate it and there is NO optimistic game-state mutation anywhere.
 *  - `ui`: ephemeral client-only state (card selection, open bottom sheet,
 *    pending action spinner, toast queue).
 */
import {
  type Card,
  type GameEvent,
  type PlayerView,
  partnerOf,
  type Rank,
  type RedealReason,
  type RuleConfig,
  SEATS,
  type Seat,
  type Suit,
  sideOf,
  type TrickPlay,
} from '@hp/engine';
import type {
  Emote,
  MatchRatingResult,
  MatchSummary,
  RoomStatePublic,
  ServerMsg,
  TurnInfo,
} from '@hp/protocol';
import { create } from 'zustand';
import { cue } from './feedback';
import i18n from './i18n';

/** App-token localStorage key (mirrors auth.ts; read directly to avoid a cycle). */
const AUTH_TOKEN_KEY = 'hp:auth';
function readAuthToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ServerError {
  code: string;
  params?: Record<string, string | number>;
}

/** A signed-in Google account, as returned by /auth/me and /auth/google. */
export interface AuthUser {
  id: string;
  name: string | null;
  picture: string | null;
  rating: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  winStreak: number;
  bestStreak: number;
  provisional: boolean;
}

export type AuthStatus = 'loading' | 'anon' | 'authing' | 'signed-in';

/** A user's saved rule configuration (the lobby "Sääntömuoto" dropdown beyond
 *  the built-in "Oletus"). `config` is a complete RuleConfig. */
export interface SavedRuleConfig {
  id: string;
  name: string;
  config: RuleConfig;
}

/** Cache of the signed-in player's unlocked achievement ids, for match-end
 *  toasts (diffed against a fresh /api/profile fetch). */
export interface AchievementsSlice {
  unlocked: string[];
  /** True once a baseline has been fetched — toasts only fire after that. */
  loaded: boolean;
}

export interface AuthSlice {
  status: AuthStatus;
  /** The signed-in account, or null when signed out. */
  user: AuthUser | null;
  /** Google client id from /api/auth-config; null = login disabled (guest-only). */
  googleClientId: string | null;
  /** True once GIS has loaded + initialised and the Sign-In button can render. */
  loginReady: boolean;
  /** The signed-in player's saved rule configurations (empty for guests). */
  ruleConfigs: SavedRuleConfig[];
  /** Id of the starred ruleset auto-selected for new games; '' = built-in
   *  "Oletus" (also '' for guests). Persisted server-side, per account. */
  defaultConfigId: string;
}

export interface ServerSlice {
  connected: boolean;
  seq: number;
  room: RoomStatePublic | null;
  /** Our seat; null = spectator / lobby guest. */
  seat: Seat | null;
  view: PlayerView | null;
  turn: TurnInfo | null;
  lastError: ServerError | null;
  /**
   * Terminal (non-retryable) server close reason as an i18n key, e.g.
   * 'error.sessionReplaced' / 'error.roomNotFound'. Set when the socket layer
   * gives up reconnecting; screens render a dead-end instead of a spinner.
   */
  fatal: string | null;
}

export type ToastKind = 'error' | 'info' | 'update' | 'achievement';

export interface Toast {
  id: number;
  kind: ToastKind;
  /** i18n key, e.g. 'error.notYourTurn' or 'event.trumpSet'. */
  code: string;
  params?: Record<string, string | number>;
}

/** Transient speech bubble rendered next to a seat's panel on the table. */
export interface SpeechBubble {
  id: number;
  seat: Seat;
  /** i18n key, e.g. 'bubble.bid'. */
  code: string;
  params?: Record<string, string | number>;
}

/** A transient reaction popping by a seat (see @hp/protocol `emoteSchema`). */
export interface EmoteBubble {
  id: number;
  seat: Seat;
  emote: Emote;
}

/** The learning topics a scenario can teach (mirrors scenarios.ts). */
export type LearnTopic = 'bidding' | 'marriage' | 'trick' | 'endgame';

/**
 * An active offline learning session (tutorial or puzzle). Drives the SAME
 * Table UI as a live game, but the game runs locally (see localMatch.ts) and a
 * guidance overlay (LearnGuide) narrates each phase. Non-null ⇒ we're in a
 * learn flow, which the Table uses to swap in learning chrome.
 */
export interface LearnSession {
  scenarioId: string;
  kind: 'tutorial' | 'puzzle';
  topic: LearnTopic;
  /** 'playing' until the deal is scored, then 'complete'. */
  status: 'playing' | 'complete';
  /** Puzzle goal outcome once complete; null for the tutorial / while playing. */
  won: boolean | null;
}

/**
 * The just-completed trick, kept around briefly so the table can show the
 * fourth card + flash the winner before the felt clears (the server snapshot
 * has already moved on to the next lead).
 */
export interface CompletedTrick {
  id: number;
  plays: TrickPlay[];
  winner: Seat;
}

export interface UiSlice {
  /** Card highlighted for a multi-card flow (exchange give/return). */
  selectedCard: Card | null;
  /** Multi-card selection for exchange give/return (tap-select N cards). */
  selectedCards: Card[];
  /** Two-step play: first tap raises, second tap plays. */
  raisedCard: Card | null;
  /** Which bottom sheet is open ('bid' | 'exchange' | 'contract' | ...). */
  openSheet: string | null;
  /** actionId of the in-flight action (spinner until server confirms). */
  pendingActionId: string | null;
  toasts: Toast[];
  /** Speech bubbles derived from update events; at most one per seat. */
  bubbles: SpeechBubble[];
  /** Player reactions currently floating by a seat; at most one per seat. */
  emotes: EmoteBubble[];
  /** Winner flash / trick linger state (see CompletedTrick). */
  completedTrick: CompletedTrick | null;
  /**
   * A redeal was demanded: who demanded it and the epoch-ms the fresh deal is
   * expected. Drives the table's countdown overlay; cleared when `dealStarted`
   * arrives. Set for ALL clients (the `redealDemanded` event is broadcast).
   */
  redeal: { seat: Seat; until: number; reason: RedealReason } | null;
  /** Latest match summaries for the current room ('history' messages). */
  history: MatchSummary[] | null;
  /**
   * Rating outcome of the just-finished match (from the `update` carrying
   * `matchEnded`). Drives the Elo delta in the match-ended overlay; cleared on
   * a fresh snapshot / new match.
   */
  matchRating: MatchRatingResult | null;
  /**
   * Active offline learning session, or null in a normal game. Set by the local
   * driver (localMatch.ts); the Table renders learning chrome (guidance overlay,
   * no emote bar) while it's non-null.
   */
  learn: LearnSession | null;
}

interface Store {
  server: ServerSlice;
  ui: UiSlice;
  auth: AuthSlice;
  achievements: AchievementsSlice;
  // ui actions (safe to call from components)
  selectCard(card: Card | null): void;
  toggleSelectedCard(card: Card, max: number): void;
  clearSelectedCards(): void;
  raiseCard(card: Card | null): void;
  setOpenSheet(sheet: string | null): void;
  setPendingAction(actionId: string | null): void;
  pushToast(toast: Omit<Toast, 'id'>): void;
  dismissToast(id: number): void;
  dismissBubble(id: number): void;
  dismissEmote(id: number): void;
  clearCompletedTrick(id: number): void;
  setHistory(matches: MatchSummary[]): void;
  setLearn(learn: LearnSession | null): void;
}

const initialServer: ServerSlice = {
  connected: false,
  seq: 0,
  room: null,
  seat: null,
  view: null,
  turn: null,
  lastError: null,
  fatal: null,
};

const initialUi: UiSlice = {
  selectedCard: null,
  selectedCards: [],
  raisedCard: null,
  openSheet: null,
  pendingActionId: null,
  toasts: [],
  bubbles: [],
  emotes: [],
  completedTrick: null,
  redeal: null,
  history: null,
  matchRating: null,
  learn: null,
};

const initialAuth: AuthSlice = {
  status: 'loading',
  user: null,
  googleClientId: null,
  loginReady: false,
  ruleConfigs: [],
  defaultConfigId: '',
};

const initialAchievements: AchievementsSlice = { unlocked: [], loaded: false };

/**
 * Redeal countdown length shown after a redeal demand — mirror of the server's
 * `redealDelayMs` (packages/server/src/timers.ts). The overlay is dismissed for
 * real when the fresh `dealStarted` arrives, so any small drift is cosmetic.
 */
const REDEAL_COUNTDOWN_MS = 5_000;

let toastSeq = 0;
let bubbleSeq = 0;
let emoteSeq = 0;
let trickFlashSeq = 0;
const TOAST_LIMIT = 5;

export const useStore = create<Store>()((set) => ({
  server: initialServer,
  ui: initialUi,
  auth: initialAuth,
  achievements: initialAchievements,

  selectCard: (card) => set((s) => ({ ui: { ...s.ui, selectedCard: card } })),
  toggleSelectedCard: (card, max) =>
    set((s) => {
      const has = s.ui.selectedCards.includes(card);
      const selectedCards = has
        ? s.ui.selectedCards.filter((c) => c !== card)
        : s.ui.selectedCards.length < max
          ? [...s.ui.selectedCards, card]
          : s.ui.selectedCards;
      return { ui: { ...s.ui, selectedCards } };
    }),
  clearSelectedCards: () => set((s) => ({ ui: { ...s.ui, selectedCards: [] } })),
  raiseCard: (card) => set((s) => ({ ui: { ...s.ui, raisedCard: card } })),
  setOpenSheet: (sheet) => set((s) => ({ ui: { ...s.ui, openSheet: sheet } })),
  setPendingAction: (actionId) => set((s) => ({ ui: { ...s.ui, pendingActionId: actionId } })),
  pushToast: (toast) =>
    set((s) => ({
      ui: { ...s.ui, toasts: [...s.ui.toasts, { ...toast, id: ++toastSeq }].slice(-TOAST_LIMIT) },
    })),
  dismissToast: (id) =>
    set((s) => ({ ui: { ...s.ui, toasts: s.ui.toasts.filter((t) => t.id !== id) } })),
  dismissBubble: (id) =>
    set((s) => ({ ui: { ...s.ui, bubbles: s.ui.bubbles.filter((b) => b.id !== id) } })),
  dismissEmote: (id) =>
    set((s) => ({ ui: { ...s.ui, emotes: s.ui.emotes.filter((e) => e.id !== id) } })),
  clearCompletedTrick: (id) =>
    set((s) => (s.ui.completedTrick?.id === id ? { ui: { ...s.ui, completedTrick: null } } : s)),
  setHistory: (matches) => set((s) => ({ ui: { ...s.ui, history: matches } })),
  setLearn: (learn) => set((s) => ({ ui: { ...s.ui, learn } })),
}));

// ── Server-slice writers (socket layer ONLY — see module doc) ───────────────

/**
 * Events worth a passive toast. `dealScored` is deliberately absent: the
 * deal-results overlay ("Jaon tulokset") is the full surface for a scored deal,
 * so a redundant toast would only flash over it.
 */
const TOASTED_EVENTS: ReadonlySet<GameEvent['type']> = new Set([
  'redealDemanded',
  'trumpSet',
  'matchEnded',
]);

function eventToast(event: GameEvent): Omit<Toast, 'id'> | null {
  if (!TOASTED_EVENTS.has(event.type)) return null;
  const toast: Omit<Toast, 'id'> = { kind: 'info', code: `event.${event.type}` };
  if (event.type === 'trumpSet') toast.params = { suit: event.suit, points: event.points };
  return toast;
}

// ── Table-UI derivations (speech bubbles + trick flash) ──────────────────────
//
// The server sends ONE update per accepted action carrying only the FIRST
// event of the resulting chain (e.g. the 4th `cardPlayed` of a trick arrives
// with a view that is already past `trickWon`). Consequence events are
// therefore derived by diffing the previous snapshot against the new one.

const BUBBLE_GLYPH: Record<Suit, string> = { H: '♥', D: '♦', C: '♣', S: '♠' };

type NewBubble = Omit<SpeechBubble, 'id'>;

function deriveBubbles(
  event: GameEvent | null,
  prev: PlayerView | null,
  next: PlayerView,
): NewBubble[] {
  const out: NewBubble[] = [];
  const nextDeal = next.deal;
  const sameDeal = prev !== null && prev.deal !== null && prev.dealIndex === next.dealIndex;
  const prevDeclCount = sameDeal && prev.deal !== null ? prev.deal.declarations.length : 0;
  const declGrew = nextDeal !== null && nextDeal.declarations.length > prevDeclCount;

  switch (event?.type) {
    case 'bidPlaced':
      out.push({ seat: event.seat, code: 'bubble.bid', params: { amount: event.amount } });
      break;
    case 'passed':
      out.push({ seat: event.seat, code: 'bubble.pass' });
      break;
    case 'redealDemanded':
      out.push({ seat: event.seat, code: 'bubble.redeal' });
      break;
    case 'contractSet':
      out.push({ seat: event.seat, code: 'bubble.contract', params: { amount: event.amount } });
      break;
    case 'askedWhole': {
      out.push({ seat: event.seat, code: 'bubble.askWhole' });
      // 0 declarable marriages → the engine auto-answered "no" in the same chain.
      const stillAnswering = nextDeal?.phase.name === 'awaitWholeAnswer';
      if (!stillAnswering && !declGrew) {
        out.push({ seat: partnerOf(event.seat), code: 'bubble.noMarriage' });
      }
      break;
    }
    case 'answeredWhole':
      if (event.suit === null) out.push({ seat: event.seat, code: 'bubble.noMarriage' });
      break;
    case 'askedHalf': {
      const asked: Rank = event.rankHeld === 'K' ? 'Q' : 'K';
      out.push({
        seat: event.seat,
        code: 'bubble.askHalf',
        params: { card: `${BUBBLE_GLYPH[event.suit]}${asked}` },
      });
      // The truthful auto-answer is in the same chain; "yes" shows up as a new
      // declaration (trump bubble below), "no" as an explicit denial.
      if (!declGrew) out.push({ seat: partnerOf(event.seat), code: 'bubble.answerNo' });
      break;
    }
    default:
      break;
  }

  if (nextDeal !== null && declGrew) {
    for (const d of nextDeal.declarations.slice(prevDeclCount)) {
      // The trump bubble sits at the seat that revealed the marriage: the
      // declarer (own) or the holder credited by a whole-ask (ohje 587) —
      // both are `d.seat` — but a half-ask credits the ASKER, so its reveal
      // comes from the partner.
      const at = d.how === 'halfAsk' ? partnerOf(d.seat) : d.seat;
      out.push({
        seat: at,
        code: 'bubble.trump',
        // `suitCode` (raw suit) lets the bubble tint the glyph by colour.
        params: { suit: BUBBLE_GLYPH[d.suit], suitCode: d.suit, points: d.points },
      });
    }
  }
  return out;
}

function deriveCompletedTrick(
  event: GameEvent | null,
  prev: PlayerView | null,
  next: PlayerView,
): Omit<CompletedTrick, 'id'> | null {
  const prevDeal = prev?.deal ?? null;
  const nextDeal = next.deal;
  if (prevDeal === null || nextDeal === null || prev?.dealIndex !== next.dealIndex) return null;
  if (nextDeal.tricksPlayed !== prevDeal.tricksPlayed + 1) return null;
  const winner = SEATS.find((s) => nextDeal.tricksWon[s] === prevDeal.tricksWon[s] + 1);
  if (winner === undefined) return null;
  let plays: TrickPlay[] | null = null;
  if (event?.type === 'cardPlayed' && prevDeal.phase.name === 'follow') {
    plays = [...prevDeal.phase.plays, { seat: event.seat, card: event.card }];
  } else if (nextDeal.lastTrick !== null) {
    plays = nextDeal.lastTrick.plays;
  }
  return plays === null ? null : { winner, plays };
}

/**
 * Fire sound + haptic feedback for a live `update`. Kept out of the setState
 * updater (which must stay pure); called after the snapshot is applied with the
 * PREVIOUS view/turn so it can tell a trick win from a loss, a sweep (läpäri)
 * from an ordinary score, and detect "it just became my turn". A null event or
 * a fresh/reconnect snapshot (prevView === null) produces no juice.
 */
function playUpdateJuice(
  msg: Extract<ServerMsg, { t: 'update' }>,
  prevView: PlayerView | null,
  prevTurnSeat: Seat | null,
  mySeat: Seat | null,
): void {
  const ev = msg.event;
  const next = msg.view;
  const players = next.config.players;

  // A scored deal that we just watched resolve — läpäri (clean sweep) or a plain
  // deal score. The winning trick's own chime is suppressed in favour of this.
  const scored =
    next.deal !== null && next.deal.phase.name === 'scored' ? next.deal.phase.result : null;
  const justScored = scored !== null && prevView !== null && prevView.deal?.phase.name !== 'scored';

  if (justScored && next.winnerSide === null) {
    const total = scored.sides.reduce((a, sd) => a + sd.tricks, 0);
    const sweep = total > 0 && scored.sides.some((sd) => sd.tricks === total);
    cue(sweep ? 'lapari' : 'dealScore');
  } else {
    const completed = ev !== null ? deriveCompletedTrick(ev, prevView, next) : null;
    if (completed !== null) {
      const mine = mySeat !== null && sideOf(completed.winner, players) === sideOf(mySeat, players);
      cue(mine ? 'trickWin' : 'trickLose');
    } else if (ev?.type === 'cardPlayed') cue('card');
    else if (ev?.type === 'bidPlaced') cue('bid');
    else if (ev?.type === 'trumpSet') cue('declare');
  }

  if (ev?.type === 'matchEnded') {
    const won = mySeat !== null && sideOf(mySeat, players) === ev.winnerSide;
    cue(won ? 'matchWin' : 'matchLose');
  } else if (
    // It just became my turn (a real transition, not a reconnect landing on it).
    mySeat !== null &&
    prevView !== null &&
    next.winnerSide === null &&
    msg.turn?.seat === mySeat &&
    prevTurnSeat !== mySeat
  ) {
    cue('yourTurn');
  }
}

/**
 * Refresh the signed-in player's unlocked achievements from /api/profile and,
 * when `toastNew` is set (a match just ended) and a baseline already exists,
 * toast each newly-unlocked one. First call establishes the baseline silently.
 */
export async function syncAchievements(toastNew: boolean): Promise<void> {
  const token = readAuthToken();
  if (token === null) return;
  try {
    const res = await fetch('/api/profile', { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const body = (await res.json()) as {
      achievements?: { unlocked?: Array<{ achievementId: string }> };
    };
    const ids = (body.achievements?.unlocked ?? []).map((u) => u.achievementId);
    const prev = useStore.getState().achievements;
    if (toastNew && prev.loaded) {
      const known = new Set(prev.unlocked);
      const fresh = ids.filter((id) => !known.has(id));
      if (fresh.length > 0) {
        useStore.setState((s) => ({
          ui: {
            ...s.ui,
            toasts: [
              ...s.ui.toasts,
              ...fresh.map((id) => ({
                id: ++toastSeq,
                kind: 'achievement' as const,
                code: 'achievements.unlocked',
                params: { name: i18n.t(`achievements.${id}.name`) },
              })),
            ].slice(-TOAST_LIMIT),
          },
        }));
      }
    }
    useStore.setState({ achievements: { unlocked: ids, loaded: true } });
  } catch {
    // best-effort; a failed sync just leaves the cached set as-is
  }
}

/** Refresh the signed-in player's saved rule configurations from the server. */
export async function syncRuleConfigs(): Promise<void> {
  const token = readAuthToken();
  if (token === null) return;
  try {
    const res = await fetch('/api/profile/configs', {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const body = (await res.json()) as {
      configs?: SavedRuleConfig[];
      defaultConfigId?: string | null;
    };
    useStore.setState((s) => ({
      auth: {
        ...s.auth,
        ruleConfigs: body.configs ?? [],
        defaultConfigId: body.defaultConfigId ?? '',
      },
    }));
  } catch {
    // best-effort; a failed sync leaves the cached configs as-is
  }
}

export const serverApply = {
  /** Socket opened but no welcome yet / socket lost. Keeps the stale view so
   *  the table stays visible under a "reconnecting" banner. */
  setConnected(connected: boolean): void {
    useStore.setState((s) => ({ server: { ...s.server, connected } }));
  },

  welcome(msg: Extract<ServerMsg, { t: 'welcome' }>): void {
    useStore.setState((s) => ({
      server: {
        connected: true,
        seq: msg.seq,
        room: msg.room,
        seat: msg.seat,
        view: msg.view,
        turn: msg.turn,
        lastError: null,
        fatal: null,
      },
      // A fresh snapshot invalidates all ephemeral interaction state.
      ui: {
        ...s.ui,
        selectedCard: null,
        selectedCards: [],
        raisedCard: null,
        pendingActionId: null,
        bubbles: [],
        emotes: [],
        completedTrick: null,
        redeal: null,
        matchRating: null,
      },
    }));
  },

  room(msg: Extract<ServerMsg, { t: 'room' }>): void {
    useStore.setState((s) => ({
      server: { ...s.server, seq: msg.seq, room: msg.room },
      ui: { ...s.ui, pendingActionId: null },
    }));
  },

  /** Snapshot-per-change: replace the game state wholesale, never merge. */
  update(msg: Extract<ServerMsg, { t: 'update' }>): void {
    // Captured before the snapshot is replaced — juice compares prev vs next.
    const beforeServer = useStore.getState().server;
    const prevView = beforeServer.view;
    const prevTurnSeat = beforeServer.turn?.seat ?? null;
    const mySeat = beforeServer.seat;
    useStore.setState((s) => {
      const toast = msg.event ? eventToast(msg.event) : null;
      const prevView = s.server.view;
      const dealBoundary =
        msg.event?.type === 'dealStarted' ||
        prevView === null ||
        prevView.dealIndex !== msg.view.dealIndex;
      const incoming = deriveBubbles(msg.event, prevView, msg.view).map((b) => ({
        ...b,
        id: ++bubbleSeq,
      }));
      // One bubble per seat: a newer line replaces the older one.
      const kept = dealBoundary
        ? []
        : s.ui.bubbles.filter((b) => !incoming.some((n) => n.seat === b.seat));
      const completed = dealBoundary ? null : deriveCompletedTrick(msg.event, prevView, msg.view);
      const completedTrick =
        completed !== null
          ? { ...completed, id: ++trickFlashSeq }
          : dealBoundary || msg.event?.type === 'cardPlayed'
            ? null
            : s.ui.completedTrick;
      // Redeal countdown: arm on the demand, clear when the fresh deal starts.
      const redeal =
        msg.event?.type === 'redealDemanded'
          ? {
              seat: msg.event.seat,
              until: Date.now() + REDEAL_COUNTDOWN_MS,
              reason: msg.event.reason,
            }
          : msg.event?.type === 'dealStarted'
            ? null
            : s.ui.redeal;
      // Post-match Elo: keep the ratings payload for the overlay; a new deal
      // (rematch) clears it.
      const matchRating =
        msg.ratings !== undefined
          ? msg.ratings
          : msg.event?.type === 'dealStarted'
            ? null
            : s.ui.matchRating;
      // Reflect the signed-in viewer's new rating on their account chip at once.
      const authUser = s.auth.user;
      const mine =
        msg.ratings?.rated && authUser
          ? msg.ratings.perSeat.find((p) => p.userId === authUser.id)
          : undefined;
      const auth =
        mine && authUser ? { ...s.auth, user: { ...authUser, rating: mine.after } } : s.auth;
      return {
        server: {
          ...s.server,
          seq: msg.seq,
          view: msg.view,
          turn: msg.turn,
          room: msg.room ?? s.server.room,
        },
        auth,
        ui: {
          ...s.ui,
          // Any accepted state change resolves the pending spinner: either our
          // action landed or the world moved on and the UI re-renders anyway.
          pendingActionId: null,
          raisedCard: null,
          selectedCard: null,
          selectedCards: [],
          bubbles: [...kept, ...incoming],
          completedTrick,
          redeal,
          matchRating,
          toasts: toast
            ? [...s.ui.toasts, { ...toast, id: ++toastSeq }].slice(-TOAST_LIMIT)
            : s.ui.toasts,
        },
      };
    });
    // Sound + haptic feedback for the moment that just landed.
    playUpdateJuice(msg, prevView, prevTurnSeat, mySeat);
    // A finished match may have unlocked achievements — refresh + toast them.
    if (msg.event?.type === 'matchEnded') void syncAchievements(true);
  },

  emote(msg: Extract<ServerMsg, { t: 'emote' }>): void {
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        // One reaction per seat: a newer one replaces the seat's current bubble.
        emotes: [
          ...s.ui.emotes.filter((e) => e.seat !== msg.seat),
          { id: ++emoteSeq, seat: msg.seat, emote: msg.emote },
        ],
      },
    }));
    cue('emote');
  },

  error(msg: Extract<ServerMsg, { t: 'error' }>): void {
    useStore.setState((s) => {
      const lastError: ServerError = msg.params
        ? { code: msg.code, params: msg.params }
        : { code: msg.code };
      const clearsPending =
        msg.refActionId !== undefined && msg.refActionId === s.ui.pendingActionId;
      const toast: Toast = msg.params
        ? { id: ++toastSeq, kind: 'error', code: msg.code, params: msg.params }
        : { id: ++toastSeq, kind: 'error', code: msg.code };
      return {
        server: { ...s.server, lastError },
        ui: {
          ...s.ui,
          pendingActionId: clearsPending ? null : s.ui.pendingActionId,
          toasts: [...s.ui.toasts, toast].slice(-TOAST_LIMIT),
        },
      };
    });
  },

  /**
   * Terminal server close (session replaced, room gone/full, version too old)
   * or, with `null`, clearing it before a fresh connection attempt. A non-null
   * code also marks us disconnected — the socket layer has stopped retrying.
   */
  setFatal(code: string | null): void {
    useStore.setState((s) => ({
      server: { ...s.server, fatal: code, connected: code === null ? s.server.connected : false },
    }));
  },

  /** Full reset (leaving a room / connecting somewhere else). */
  reset(): void {
    useStore.setState((s) => ({ server: initialServer, ui: { ...initialUi }, auth: s.auth }));
  },
};

// ── Auth-slice writers (auth layer ONLY — see auth.ts) ───────────────────────

export const authApply = {
  /** The public client id from /api/auth-config (null → login disabled). */
  setClientId(googleClientId: string | null): void {
    useStore.setState((s) => ({
      auth: {
        ...s.auth,
        googleClientId,
        // Boot finished with no signed-in user → settle into the anonymous state.
        status: s.auth.user ? 'signed-in' : s.auth.status === 'loading' ? 'anon' : s.auth.status,
      },
    }));
  },

  setStatus(status: AuthStatus): void {
    useStore.setState((s) => ({ auth: { ...s.auth, status } }));
  },

  /** GIS has loaded and initialised; the Sign-In button can now be rendered. */
  setLoginReady(): void {
    useStore.setState((s) => ({ auth: { ...s.auth, loginReady: true } }));
  },

  /** Set (or clear) the signed-in account. */
  setUser(user: AuthUser | null): void {
    useStore.setState((s) => ({
      auth: {
        ...s.auth,
        user,
        status: user ? 'signed-in' : 'anon',
        ruleConfigs: [],
        defaultConfigId: '',
      },
    }));
    // Establish (or clear) the achievements baseline for match-end toasts, and
    // load (or clear) the account's saved rule configurations + starred default.
    if (user) {
      void syncAchievements(false);
      void syncRuleConfigs();
    } else useStore.setState({ achievements: initialAchievements });
  },

  /** Replace the cached saved rule configurations (after a create/edit/delete). */
  setRuleConfigs(configs: SavedRuleConfig[]): void {
    useStore.setState((s) => ({ auth: { ...s.auth, ruleConfigs: configs } }));
  },

  /** Set the starred default ruleset id ('' = built-in "Oletus"). Used to reflect
   *  a star change optimistically before the server confirms it. */
  setDefaultConfigId(id: string): void {
    useStore.setState((s) => ({ auth: { ...s.auth, defaultConfigId: id } }));
  },
};
