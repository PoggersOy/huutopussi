/**
 * The bot contract (plan.md §Bots): a bot sees exactly what a human client
 * sees — the redacted PlayerView plus the server-computed ActionHints for its
 * seat — and never the full MatchState. This both guarantees fairness and is
 * living proof that PlayerView + hints suffice to play the game.
 */
import type { ActionHint, PlayerAction, PlayerView } from '@hp/engine';

export interface Actor {
  onTurn(view: PlayerView, hints: ActionHint[]): PlayerAction | Promise<PlayerAction>;
  /**
   * Optional: receives every snapshot this seat would be sent (not only its
   * own turns) — the same stream a human client renders — so a bot with card
   * memory never misses a play. Never called with another seat's view.
   */
  observe?(view: PlayerView): void;
}
