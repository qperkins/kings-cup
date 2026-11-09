/** Order-independent identity of a roster: changes only when someone joins or leaves. */
export function rosterKey(ids: readonly string[]): string {
  return [...ids].sort().join(",");
}
