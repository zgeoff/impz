import type { Bound, Side } from './bound';
import type { Comparison } from './comparison';
import { formatChange } from './format-change';
import { formatSides } from './format-sides';
import { isWithin } from './is-within';

export function collectBoundChange(
  name: string,
  narrow: Bound | undefined,
  wide: Bound | undefined,
  side: Side,
  path: string,
  comparison: Comparison,
): string[] {
  if (wide === undefined || (narrow !== undefined && isWithin(narrow, wide, side))) {
    return [];
  }

  const change = formatSides(comparison, narrow, wide, (bound) => formatBound(bound, side));

  return [formatChange(path, `${name} ${change}`)];
}

function formatBound(bound: Bound | undefined, side: Side): string {
  if (bound === undefined) {
    return 'none';
  }

  const sign = side === 'lower' ? '>' : '<';

  return `${bound.exclusive ? sign : `${sign}=`} ${String(bound.value)}`;
}
