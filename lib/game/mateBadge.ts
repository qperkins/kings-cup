/** Compact label for the heart badge on a player's avatar: one mate shows their initial,
 * several show a count, so the badge never grows wide enough to collide with the Host tag. */
export function mateBadgeLabel(mateNames: readonly string[]): string {
  if (mateNames.length === 0) return "";
  if (mateNames.length === 1) return (mateNames[0] ?? "?").charAt(0).toUpperCase();
  return String(mateNames.length);
}
