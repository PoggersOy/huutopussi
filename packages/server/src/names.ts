/**
 * names.ts — display-name minimization (GDPR data-minimization, art. 5.1.c).
 *
 * Google hands us a real full name ("Samuli Vainio"); we never store or show
 * more than "First L." so a player's surname never crosses the login boundary.
 * Applied at the single choke point where a Google identity is verified
 * (auth.ts), and once more in a migration for names persisted by older builds
 * (db.ts). The transform is idempotent — shortenDisplayName("Samuli V.") is
 * "Samuli V." again — so re-running it on every boot is always safe.
 */

/**
 * "Samuli Vainio" → "Samuli V."; "Samuli Ilmari Vainio" → "Samuli V." (the
 * LAST token supplies the initial); a single token ("Samuli") is returned
 * unchanged; blank/absent → null. The trailing period is intentional — the
 * conventional abbreviation ("Samuli V.", not "Samuli V").
 */
export function shortenDisplayName(name: string | null): string | null {
  if (name === null) return null;
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  const first = parts[0];
  if (first === undefined) return null;
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1] ?? '';
  const initial = last.charAt(0).toUpperCase();
  return initial === '' ? first : `${first} ${initial}.`;
}
