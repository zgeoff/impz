import type { Bound, Side } from './bound';
import { isWithin } from './is-within';

export function pickTighter(
  a: Bound | undefined,
  b: Bound | undefined,
  side: Side,
): Bound | undefined {
  if (a === undefined || b === undefined) {
    return a ?? b;
  }

  return isWithin(a, b, side) ? a : b;
}
