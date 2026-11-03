// How much of the sidebar the Library's lists take by default: Collections and References
// together get at most half its height, so the workspace's own items stay in view. Each list
// shows the rows that fit and a "Show more" row; one that needs less than its share gives
// the rest to the other.

/** A tree row (28px) and the 1px between rows. */
export const ROW_PX = 29;
/** A reference: title over byline. */
export const REFERENCE_PX = 40;

/** Splits `total` px between two lists that need `a` and `b`. */
export function share(total: number, a: number, b: number): [number, number] {
  if (a + b <= total) return [a, b];
  const half = total / 2;
  if (a < half) return [a, total - a];
  if (b < half) return [total - b, b];
  return [half, half];
}

/** How many of `count` rows to show in `budget` px (undefined: all of them). Leaves room
 *  for the "Show more" row and always shows a few. */
export function rowsThatFit(budget: number | undefined, count: number, rowPx: number, reserved = 0): number | undefined {
  if (budget === undefined) return undefined;
  const fit = Math.floor((budget - reserved) / rowPx);
  if (count <= fit) return undefined;
  return Math.max(2, fit - 1);
}
