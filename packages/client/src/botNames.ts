/**
 * Bot display names. Bots carry no server-side nickname (it's `null`), so the
 * client names them itself — and does so per-language (Matti/Matt …), which a
 * stored nickname could not do. The `lobby.botName*` names are handed out in
 * seat order: the lowest-seat bot is the first name, the next bot the second,
 * and so on. Only `kind === 'bot'` seats count — a human seat temporarily played
 * by a bot (`botControlled`) keeps its own nickname.
 */
import type { SeatInfo } from '@hp/protocol';
import { useTranslation } from 'react-i18next';
import { useStore } from './store';

/**
 * Localized name for a bot `seat`, chosen by its ordinal among the bot seats in
 * `seats` (seat order). Returns null for non-bot seats or when the bots outnumber
 * the available names (callers fall back to the generic `lobby.bot` label).
 */
export function botNameOf(seats: SeatInfo[], seat: number, botNames: string[]): string | null {
  let ordinal = 0;
  for (const s of seats) {
    if (s.kind !== 'bot') continue;
    if (s.seat === seat) return botNames[ordinal] ?? null;
    ordinal += 1;
  }
  return null;
}

/** The localized bot-name pool, in the order bots are named. */
export function useBotNames(): string[] {
  const { t } = useTranslation();
  return [t('lobby.botNameA'), t('lobby.botNameB'), t('lobby.botNameC')];
}

/**
 * Seat-indexed display names for a FINISHED-match summary. Bot seats were stored
 * as a null name (bots carry no nickname), so fill the null slots — in seat
 * order — with `botNames`, the same localized pool the live table used, matching
 * the ordinal scheme in `botNameOf`. A null slot past the pool becomes the
 * generic `botLabel`. Named (human) seats keep their stored nickname; a missing
 * `names` array yields an empty result (caller labels seats generically).
 */
export function summaryNames(
  names: (string | null)[] | undefined,
  botNames: string[],
  botLabel: string,
): string[] {
  let ordinal = 0;
  return (names ?? []).map((name) => {
    if (name !== null) return name;
    const botName = botNames[ordinal] ?? botLabel;
    ordinal += 1;
    return botName;
  });
}

/** Hook form: `(seat) => localized bot name | null` for the current room. */
export function useBotName(): (seat: number) => string | null {
  const room = useStore((s) => s.server.room);
  const botNames = useBotNames();
  return (seat) => (room ? botNameOf(room.seats, seat, botNames) : null);
}
