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
import type { Card, GameEvent, PlayerView, Seat } from '@hp/engine';
import type { RoomStatePublic, ServerMsg, TurnInfo } from '@hp/protocol';
import { create } from 'zustand';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ServerError {
  code: string;
  params?: Record<string, string | number>;
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
}

export type ToastKind = 'error' | 'info' | 'update';

export interface Toast {
  id: number;
  kind: ToastKind;
  /** i18n key, e.g. 'error.notYourTurn' or 'event.trumpSet'. */
  code: string;
  params?: Record<string, string | number>;
}

export interface UiSlice {
  /** Card highlighted for a multi-card flow (exchange give/return). */
  selectedCard: Card | null;
  /** Two-step play: first tap raises, second tap plays. */
  raisedCard: Card | null;
  /** Which bottom sheet is open ('bid' | 'exchange' | 'contract' | ...). */
  openSheet: string | null;
  /** actionId of the in-flight action (spinner until server confirms). */
  pendingActionId: string | null;
  toasts: Toast[];
}

interface Store {
  server: ServerSlice;
  ui: UiSlice;
  // ui actions (safe to call from components)
  selectCard(card: Card | null): void;
  raiseCard(card: Card | null): void;
  setOpenSheet(sheet: string | null): void;
  setPendingAction(actionId: string | null): void;
  pushToast(toast: Omit<Toast, 'id'>): void;
  dismissToast(id: number): void;
}

const initialServer: ServerSlice = {
  connected: false,
  seq: 0,
  room: null,
  seat: null,
  view: null,
  turn: null,
  lastError: null,
};

const initialUi: UiSlice = {
  selectedCard: null,
  raisedCard: null,
  openSheet: null,
  pendingActionId: null,
  toasts: [],
};

let toastSeq = 0;
const TOAST_LIMIT = 5;

export const useStore = create<Store>()((set) => ({
  server: initialServer,
  ui: initialUi,

  selectCard: (card) => set((s) => ({ ui: { ...s.ui, selectedCard: card } })),
  raiseCard: (card) => set((s) => ({ ui: { ...s.ui, raisedCard: card } })),
  setOpenSheet: (sheet) => set((s) => ({ ui: { ...s.ui, openSheet: sheet } })),
  setPendingAction: (actionId) => set((s) => ({ ui: { ...s.ui, pendingActionId: actionId } })),
  pushToast: (toast) =>
    set((s) => ({
      ui: { ...s.ui, toasts: [...s.ui.toasts, { ...toast, id: ++toastSeq }].slice(-TOAST_LIMIT) },
    })),
  dismissToast: (id) =>
    set((s) => ({ ui: { ...s.ui, toasts: s.ui.toasts.filter((t) => t.id !== id) } })),
}));

// ── Server-slice writers (socket layer ONLY — see module doc) ───────────────

/** Events worth a passive toast even in the crude foundation UI. */
const TOASTED_EVENTS: ReadonlySet<GameEvent['type']> = new Set([
  'redealDemanded',
  'trumpSet',
  'dealScored',
  'matchEnded',
]);

function eventToast(event: GameEvent): Omit<Toast, 'id'> | null {
  if (!TOASTED_EVENTS.has(event.type)) return null;
  const toast: Omit<Toast, 'id'> = { kind: 'info', code: `event.${event.type}` };
  if (event.type === 'trumpSet') toast.params = { suit: event.suit, points: event.points };
  return toast;
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
      },
      // A fresh snapshot invalidates all ephemeral interaction state.
      ui: { ...s.ui, selectedCard: null, raisedCard: null, pendingActionId: null },
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
    useStore.setState((s) => {
      const toast = msg.event ? eventToast(msg.event) : null;
      return {
        server: {
          ...s.server,
          seq: msg.seq,
          view: msg.view,
          turn: msg.turn,
          room: msg.room ?? s.server.room,
        },
        ui: {
          ...s.ui,
          // Any accepted state change resolves the pending spinner: either our
          // action landed or the world moved on and the UI re-renders anyway.
          pendingActionId: null,
          raisedCard: null,
          selectedCard: null,
          toasts: toast
            ? [...s.ui.toasts, { ...toast, id: ++toastSeq }].slice(-TOAST_LIMIT)
            : s.ui.toasts,
        },
      };
    });
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

  /** Full reset (leaving a room / connecting somewhere else). */
  reset(): void {
    useStore.setState({ server: initialServer, ui: { ...initialUi } });
  },
};
