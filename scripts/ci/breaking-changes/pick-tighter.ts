import type { Bound, Side } from './bound';
import { isWithin } from './is-within';

export function pickTighter(
  left: Bound | undefined,
  right: Bound | undefined,
  side: Side,
): Bound | undefined {
  if (left === undefined || right === undefined) {
    return left ?? right;
  }

  return isWithin(left, right, side) ? left : right;
}
