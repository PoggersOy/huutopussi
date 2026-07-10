/**
 * The bot contract (plan.md §Bots): a bot sees exactly what a human client
 * sees — the redacted PlayerView plus the server-computed ActionHints for its
 * seat — and never the full MatchState. This both guarantees fairness and is
 * living proof that PlayerView + hints suffice to play the game.
 */
import type { ActionHint, PlayerAction, PlayerView } from '@hp/engine';

export interface Actor {
  onTurn(view: PlayerView, hints: ActionHint[]): PlayerAction | Promise<PlayerAction>;
}
